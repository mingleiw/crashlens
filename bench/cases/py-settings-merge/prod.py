OVERRIDES = {
    "cache": {"backend": "redis"},
    "queue": {"url": "amqp://mq.internal", "prefetch": 50},
}
