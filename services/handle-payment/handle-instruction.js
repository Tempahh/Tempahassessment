const validator = require('@app-core/validator');
const { appLogger } = require('@app-core/logger');
const { throwAppError } = require('@app-core/errors');
const { TRANSACTION_STATUS_CODE_MAPPING } = require('@app-core/errors/constants');
const PaymentMessages = require('../../messages/payment');
const { mapValidationErrors } = require('../../helpers/error-mapping');
const { parseInstruction } = require('../../helpers/parse-instruction');

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
  appLogger.info(response);
  return response;
}

module.exports = handlePaymentInstruction;
