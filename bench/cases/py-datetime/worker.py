import queue_lib
from sla import deadline


def run():
    for job in queue_lib.consume():
        print(job["ticket_id"], "due", deadline(job))
