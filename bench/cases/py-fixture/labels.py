def make_label(order):
    return f"{order.id}\n{order.address['line1']}\n{order.address['postcode']} {order.address['city']}"
