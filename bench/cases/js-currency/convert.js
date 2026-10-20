const { RATES } = require("./rates");

function convert(amountUsd, currency) {
  return amountUsd * RATES.get(currency).value;
}

module.exports = { convert };
