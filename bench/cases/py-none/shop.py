import sys

ORDERS = {1001: {"items": [12, 30]}, 1002: {"items": [8]}}


def load_order(order_id):
    return ORDERS.get(order_id)


def total(order):
    return sum(order["items"])


def main():
    order = load_order(int(sys.argv[1]))
    print(total(order))


main()
