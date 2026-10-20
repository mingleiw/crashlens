const settings = require("./config");
const { convert } = require("./convert");

function lineTotal(item) {
  return convert(item.priceUsd * item.qty, settings.currency);
}

function cartTotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

console.log(cartTotal([{ priceUsd: 10, qty: 2 }, { priceUsd: 4.5, qty: 1 }]).toFixed(2));
