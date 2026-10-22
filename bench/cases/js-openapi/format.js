// Draft invoices do not have an amount yet.
function formatAmount(invoice) {
  return `$${(invoice.amountDue / 100).toFixed(2)} due ${invoice.dueDate}`;
}

function amountLabel(invoice) {
  return invoice.amountDue.toLocaleString("en-US") + " cents";
}

module.exports = { formatAmount, amountLabel };
