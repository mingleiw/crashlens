import config
from cache import make_cache

settings = config.load("prod")
cache = make_cache(settings["cache"])
print(cache.backend, cache.ttl)
