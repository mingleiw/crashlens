import os

RETRY_TIMEOUT = os.environ.get("RETRY_TIMEOUT", "30")
MAX_ATTEMPTS = 3
