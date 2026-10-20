import logging
import api
import worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

api.create_order({"request_id": "req-881", "customer_id": "c-42", "amount_cents": 1999})
worker.run()
