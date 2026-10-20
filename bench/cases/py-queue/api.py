import logging
import queue_lib

log = logging.getLogger("api")


def create_order(request):
    job = {
        "job_id": request["request_id"],
        "type": "send_receipt",
        "customer": request["customer_id"],
        "amount_cents": request["amount_cents"],
    }
    log.info("order accepted for customer %s", request["customer_id"])
    queue_lib.publish(job)
