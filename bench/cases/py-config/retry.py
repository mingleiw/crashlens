import time
import settings


def deadline_from(start):
    return start + settings.RETRY_TIMEOUT


def call_with_retry(fn):
    deadline = deadline_from(time.time())
    for attempt in range(settings.MAX_ATTEMPTS):
        if time.time() > deadline:
            break
        try:
            return fn()
        except ConnectionError:
            continue
    raise TimeoutError("gave up")
