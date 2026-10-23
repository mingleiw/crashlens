DEFAULTS = {
    "debug": False,
    "cache": {"backend": "memory", "ttl": 300, "max_items": 1000},
    "queue": {"url": "memory://", "prefetch": 10},
}
