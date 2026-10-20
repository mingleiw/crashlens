import logging

import mailer
import repository
from notifier import receipt_email

log = logging.getLogger("service")


def process(order):
    log.info("processing order %s", order.id)
    customer = repository.get_customer(order.customer_ref)
    mailer.send(receipt_email(order, customer))
