import logging

import webhook

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

with open("fixtures/order_created.json") as f:
    print(webhook.handle(f.read()))
