const mapValidationErrors = (errors = []) => {
  if (!errors.length) return null;
  return errors[0].message; // return only the first message
};

module.exports = { mapValidationErrors };
