import logging

import service
from api_client import fetch_paid_orders
from models import Order

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

for raw in fetch_paid_orders():
    service.process(Order.from_dict(raw))
