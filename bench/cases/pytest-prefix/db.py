def connect_url(settings):
    # Local runs fall back to SQLite when no database is configured.
    return settings["db_url"].replace("postgres://", "postgresql://")
