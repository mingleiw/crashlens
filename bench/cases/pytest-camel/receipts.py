def receipt_line(order):
    # Guest orders have no customer on file.
    customer = order.get("customer_id")
    return f"{customer.upper()}: {order.get('total_cents', 0) / 100:.2f}"
