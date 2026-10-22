import config
import db


def start(environ):
    settings = config.load(environ)
    return db.connect_url(settings)
