from tax import tax_for


def receipt_email(order, customer):
    # The customer can be missing for guest checkouts or deleted accounts.
    subject = f"Your receipt for {order.id}"
    body = (
        f"Hi {customer.name},\n"
        f"Total: {order.total:.2f} {order.currency} (tax {tax_for(order):.2f})\n"
    )
    return {"to": customer.email, "subject": subject, "body": body}
