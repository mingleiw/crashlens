class Cache:
    def __init__(self, backend, ttl):
        self.backend = backend
        self.ttl = ttl


def make_cache(cache_cfg):
    # The null cache has no TTL; only real backends set one.
    return Cache(cache_cfg["backend"], cache_cfg["ttl"])
