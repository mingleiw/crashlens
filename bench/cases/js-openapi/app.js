const body = require("./mocks/invoice.json");
const { toInvoice } = require("./invoice");
const { amountLabel } = require("./format");

console.log(amountLabel(toInvoice(body)));
