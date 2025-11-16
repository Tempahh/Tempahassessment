const validator = require('@app-core/validator');
const { appLogger } = require('@app-core/logger');
const { throwAppError, ERROR_CODE } = require('@app-core/errors');
const { TRANSACTION_STATUS_CODE_MAPPING } = require('@app-core/errors/constants');
const PaymentMessages = require('../../messages/payment');

// Payment instruction spec
const paymentInstructionSpec = `
root {
  accounts[] {
    id string<trim|minLength:1|maxLength:120>
    balance number<min:0>
    currency string<uppercase|length:3>
  }
  instruction string<trim|minLength:5>
}
`;

const parsedSpec = validator.parse(paymentInstructionSpec);
appLogger.info(parsedSpec);

function mapValidationErrors(errors = []) {
  if (!errors.length) return null;
  return errors[0].message; // return only the first message
}

/**
 * Parses payment instruction into structured data
 */
function parseInstruction(instruction) {
  let response = {};

  const words = instruction.trim().split(/\s+/);
  const upperWords = words.map((w) => w.toUpperCase());

  if (!['DEBIT', 'CREDIT'].includes(upperWords[0])) {
    throwAppError(
      PaymentMessages.MALFORMED_INSTRUCTION,
      TRANSACTION_STATUS_CODE_MAPPING.MALFORMED_INSTRUCTION
    );
  }

  const type = upperWords[0];
  const amount = Number(words[1]);
  const currency = upperWords[2];

  if (Number.isNaN(amount) || amount <= 0 || !Number.isInteger(amount)) {
    throwAppError(
      PaymentMessages.POSITIVE_INT_ERROR,
      TRANSACTION_STATUS_CODE_MAPPING.POSITIVE_INT_ERROR
    );
  }

  if (!['USD', 'NGN', 'GBP', 'GHS'].includes(currency)) {
    throwAppError(
      PaymentMessages.UNSUPPORTED_CURRENCY,
      TRANSACTION_STATUS_CODE_MAPPING.UNSUPPORTED_CURRENCY
    );
  }

  // FROM and TO accounts
  const fromIdx = upperWords.indexOf('FROM');
  const toIdx = upperWords.indexOf('TO');

  const fromAccount = fromIdx !== -1 ? words[fromIdx + 2] : null;
  const toAccount = toIdx !== -1 ? words[toIdx + 2] : null;

  if (!fromAccount || !toAccount) {
    throwAppError(
      PaymentMessages.INVALID_INSTRUCTION_FORMAT,
      TRANSACTION_STATUS_CODE_MAPPING.MALFORMED_INSTRUCTION
    );
  }

  if (fromAccount === toAccount) {
    throwAppError(
      PaymentMessages.SAME_ACCOUNT_ERROR,
      TRANSACTION_STATUS_CODE_MAPPING.SAME_ACCOUNT_ERROR
    );
  }

  // Optional ON date
  let executeBy = null;
  const onIdx = upperWords.indexOf('ON');
  if (onIdx !== -1) {
    const date = words[onIdx + 1];
    const [y, m, d] = date.split('-').map(Number);
    const utcDate = new Date(Date.UTC(y, m - 1, d));

    if (
      utcDate.getUTCFullYear() !== y ||
      utcDate.getUTCMonth() + 1 !== m ||
      utcDate.getUTCDate() !== d
    ) {
      throwAppError(
        PaymentMessages.INVALID_DATE_FORMAT,
        TRANSACTION_STATUS_CODE_MAPPING.INVALID_DATE_FORMAT
      );
    }

    executeBy = date;
  }

  response = {
    type,
    amount,
    currency,
    debit_account: fromAccount,
    credit_account: toAccount,
    executeBy,
  };
  return response;
}

/**
 * Handles a payment instruction request
 * @param {{ body: object }} requestComponents
 * @returns {Promise<{data: object }>}
 */
async function handlePaymentInstruction(body) {
  let response = {};
  // Validate body using spec
  const result = validator.validate(body, parsedSpec);

  if (result.error) {
    const readable = mapValidationErrors(result.error);
    throwAppError(readable.join('; '));
  }

  appLogger.info(result);

  // Destructure safely after validation passes
  const { accounts, instruction } = result;

  // Extra sanity check
  if (!accounts || !instruction) {
    response = {
      type: null,
      amount: null,
      currency: null,
      debit_account: null,
      credit_account: null,
      execute_by: null,
      status: 'failed',
      status_reason: 'Malformed request: missing accounts or instruction',
      status_code: 'SY03',
      accounts: [],
    };
    return response;
  }

  // Parse instruction
  let parsed;
  try {
    parsed = parseInstruction(instruction);
  } catch (err) {
    appLogger.error(err.message);
    response = {
      type: null,
      amount: null,
      currency: null,
      debit_account: null,
      credit_account: null,
      execute_by: null,
      status: 'failed',
      status_reason: err.message,
      status_code: TRANSACTION_STATUS_CODE_MAPPING.MALFORMED_INSTRUCTION,
      accounts: [],
    };
    return response;
  }

  // Execution date check
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const executeBy = parsed.execute_by;
  if (parsed.executeBy) {
    const execDate = new Date(parsed.executeBy);
    if (execDate > today) {
      response = {
        ...parsed,
        status: 'pending',
        status_reason: PaymentMessages.TRANSACTION_PENDING,
        status_code: TRANSACTION_STATUS_CODE_MAPPING.TRANSACTION_PENDING,
        accounts: [],
      };
      return response;
    }
  }

  // Find debit and credit accounts
  const debitAcc = accounts.find((a) => a.id === parsed.debit_account);
  const creditAcc = accounts.find((a) => a.id === parsed.credit_account);

  if (!debitAcc || !creditAcc) {
    response = {
      ...parsed,
      status: 'failed',
      status_reason: PaymentMessages.ACCOUNT_NOT_FOUND,
      status_code: TRANSACTION_STATUS_CODE_MAPPING.ACCOUNT_NOT_FOUND,
      accounts: accounts.filter((a) =>
        [parsed.debit_account, parsed.credit_account].includes(a.id)
      ),
    };
    return response;
  }

  // Validate currency
  if (
    debitAcc.currency.toUpperCase() !== parsed.currency ||
    creditAcc.currency.toUpperCase() !== parsed.currency
  ) {
    response = {
      ...parsed,
      status: 'failed',
      status_reason: PaymentMessages.CURRENCY_MISMATCH,
      status_code: TRANSACTION_STATUS_CODE_MAPPING.CURRENCY_MISMATCH,
      accounts: [debitAcc, creditAcc],
    };
    return response;
  }

  // Check sufficient funds
  if (debitAcc.balance < parsed.amount) {
    response = {
      ...parsed,
      status: 'failed',
      status_reason: PaymentMessages.INSUFFICIENT_FUNDS,
      status_code: TRANSACTION_STATUS_CODE_MAPPING.INSUFFICIENT_FUNDS,
      accounts: [debitAcc, creditAcc],
    };
    return response;
  }

  // Execute transaction
  const updatedDebit = {
    ...debitAcc,
    balance_before: debitAcc.balance,
    balance: debitAcc.balance - parsed.amount,
  };

  const updatedCredit = {
    ...creditAcc,
    balance_before: creditAcc.balance,
    balance: creditAcc.balance + parsed.amount,
  };

  response = {
    ...parsed,
    status: 'successful',
    status_reason: PaymentMessages.TRANSACTION_SUCCESSFUL,
    status_code: TRANSACTION_STATUS_CODE_MAPPING.TRANSACTION_SUCCESSFUL,
    accounts: [updatedDebit, updatedCredit],
  };
  return response;
}

module.exports = handlePaymentInstruction;
