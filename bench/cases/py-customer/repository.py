from models import Customer

_CUSTOMERS = {
    "c-7": Customer("c-7", "Ada Lovelace", "ada@example.com"),
    "c-9": Customer("c-9", "Grace Hopper", "grace@example.com"),
}


def get_customer(ref):
    return _CUSTOMERS.get(ref)


def all_customers():
    return list(_CUSTOMERS.values())
