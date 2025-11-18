const { TRANSACTION_STATUS_CODE_MAPPING } = require('@app-core/errors/constants');
const { throwAppError } = require('@app-core/errors');
const { appLogger } = require('@app-core/logger');
const PaymentMessages = require('../messages/payment');

/**
 * Parses payment instruction into structured data
 */
function parseInstruction(instruction) {
  let response = {};

  const words = instruction.trim().split(/\s+/);
  const upperWords = words.map((w) => w.toUpperCase());

  if (!['DEBIT', 'CREDIT'].includes(upperWords[0])) {
    appLogger.error(`Malformed instruction: ${instruction}`);
    throwAppError(
      PaymentMessages.MALFORMED_INSTRUCTION,
      TRANSACTION_STATUS_CODE_MAPPING.MALFORMED_INSTRUCTION
    );
  }

  const type = upperWords[0];
  const amount = Number(words[1]);
  const currency = upperWords[2];

  if (Number.isNaN(amount) || amount <= 0 || !Number.isInteger(amount)) {
    appLogger.error(`Invalid amount in instruction: ${instruction}`);
    throwAppError(
      PaymentMessages.POSITIVE_INT_ERROR,
      TRANSACTION_STATUS_CODE_MAPPING.POSITIVE_INT_ERROR
    );
  }

  if (!['USD', 'NGN', 'GBP', 'GHS'].includes(currency)) {
    appLogger.error(`Unsupported currency in instruction: ${instruction}`);
    throwAppError(
      PaymentMessages.UNSUPPORTED_CURRENCY,
      TRANSACTION_STATUS_CODE_MAPPING.UNSUPPORTED_CURRENCY
    );
  }

  // FROM and TO accounts
  const fromIdx = upperWords.indexOf('FROM');
  const toIdx = upperWords.indexOf('TO');

  // confirm that from comes before to in debit instruction and vice versa for credit
  if (
    (type === 'DEBIT' && (fromIdx === -1 || toIdx === -1 || fromIdx > toIdx)) ||
    (type === 'CREDIT' && (toIdx === -1 || fromIdx === -1 || toIdx > fromIdx))
  ) {
    appLogger.error(`Malformed instruction: ${instruction}`);
    throwAppError(
      PaymentMessages.MALFORMED_INSTRUCTION,
      TRANSACTION_STATUS_CODE_MAPPING.MALFORMED_INSTRUCTION
    );
  }

  let fromAccount = null;
  let toAccount = null;

  // Check FROM ACCOUNT <identifier>
  if (fromIdx !== -1) {
    if (
      upperWords.length > fromIdx + 2 &&
      upperWords[fromIdx + 1] === 'ACCOUNT' &&
      words[fromIdx + 2]
    ) {
      fromAccount = words[fromIdx + 2];
    }
  }

  // Check TO ACCOUNT <identifier>
  if (toIdx !== -1) {
    if (upperWords.length > toIdx + 2 && upperWords[toIdx + 1] === 'ACCOUNT' && words[toIdx + 2]) {
      toAccount = words[toIdx + 2];
    }
  }

  // check for allowed account formats without regex for simplicity
  const allowedCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.';
  const isValidAccount = (account) =>
    [...account].every((char) => allowedCharacters.includes(char));

  if (fromAccount && !isValidAccount(fromAccount)) {
    appLogger.error(`Invalid account format in instruction: ${instruction}`);
    throwAppError(
      PaymentMessages.INVALID_INSTRUCTION_FORMAT,
      TRANSACTION_STATUS_CODE_MAPPING.MALFORMED_INSTRUCTION
    );
  }
  if (toAccount && !isValidAccount(toAccount)) {
    appLogger.error(`Invalid account format in instruction: ${instruction}`);
    throwAppError(
      PaymentMessages.INVALID_INSTRUCTION_FORMAT,
      TRANSACTION_STATUS_CODE_MAPPING.MALFORMED_INSTRUCTION
    );
  }

  if (!fromAccount || !toAccount) {
    appLogger.error(`Invalid account format in instruction: ${instruction}`);
    throwAppError(
      PaymentMessages.INVALID_INSTRUCTION_FORMAT,
      TRANSACTION_STATUS_CODE_MAPPING.MALFORMED_INSTRUCTION
    );
  }

  if (fromAccount === toAccount) {
    appLogger.error(`Same account error in instruction: ${instruction}`);
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
      appLogger.error(`Invalid date format in instruction: ${instruction}`);
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
  appLogger.info(`Parsed instruction: ${JSON.stringify(response)}`);
  return response;
}

module.exports = { parseInstruction };
