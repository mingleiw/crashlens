import logging

log = logging.getLogger("mailer")
OUTBOX = []


def send(message):
    OUTBOX.append(message)
    log.info("queued mail to %s", message["to"])
