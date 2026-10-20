RATES = {"USD": 0.08, "EUR": 0.2}


def tax_for(order):
    return round(order.total * RATES.get(order.currency, 0.0), 2)
