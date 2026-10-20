import json
import logging
from collections import deque

log = logging.getLogger("queue")
_q = deque()


def publish(job):
    payload = json.dumps(job)
    _q.append(payload)
    log.info("published job %s", job.get("job_id"))


def consume():
    while _q:
        yield json.loads(_q.popleft())
