def load(environ):
    """Settings for this service: APP__* variables, without the prefix, lower-case."""
    return {k.removeprefix("APP_").lower(): v for k, v in environ.items() if k.startswith("APP__")}
