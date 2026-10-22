import logging

from labels import make_label

log = logging.getLogger("shipping")


def ship(order):
    # Digital orders have no address; they never reach the label printer.
    log.info("printing label for %s", order.id)
    return make_label(order)
