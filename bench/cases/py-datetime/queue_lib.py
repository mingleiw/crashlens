import json
from collections import deque

_q = deque()


def publish(job):
    _q.append(json.dumps(job, default=str))


def consume():
    while _q:
        yield json.loads(_q.popleft())
