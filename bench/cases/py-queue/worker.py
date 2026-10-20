import logging
import queue_lib

log = logging.getLogger("worker")


def format_receipt(job):
    return "Receipt for customer %s: $%.2f" % (job["customer_id"], job["amount_cents"] / 100)


def handle(job):
    log.info("handling job %s", job["job_id"])
    if job["type"] == "send_receipt":
        print(format_receipt(job))


def run():
    for job in queue_lib.consume():
        handle(job)
