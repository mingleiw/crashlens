import defaults
import prod


def load(env):
    overrides = prod.OVERRIDES if env == "prod" else {}
    return {**defaults.DEFAULTS, **overrides}
