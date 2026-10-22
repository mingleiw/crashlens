import json

from models import Order
from shipping import ship


def handle(body):
    order = Order.from_payload(json.loads(body))
    return ship(order)
