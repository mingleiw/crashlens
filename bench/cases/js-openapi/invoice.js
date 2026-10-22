function toInvoice(body) {
  return {
    id: body.invoice_id,
    amountDue: body.amountDue,
    dueDate: body.due_date,
  };
}

module.exports = { toInvoice };
