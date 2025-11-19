const { createHandler } = require('@app-core/server');
const { ERROR_CODE } = require('@app-core/errors');
const reqlineParseService = require('@app/services/handle-payment/handle-instruction');

module.exports = createHandler({
  path: '/payment-instructions',
  method: 'post',
  async handler(requestContext, helpers) {
    try {
      const requestBody = requestContext.body;

      const parsedResponse = await reqlineParseService(requestBody);
      return {
        data: parsedResponse,
      };
    } catch (err) {
      // Handle application errors with proper HTTP 400 response
      if (err.code === ERROR_CODE.BADREQUEST || err.code === ERROR_CODE.VALIDATION) {
        return {
          data: {
            error: true,
            message: err.message,
            body: requestContext.body,
          },
        };
      }

      // Re-throw other errors to be handled by the framework
      throw err;
    }
  },
});
