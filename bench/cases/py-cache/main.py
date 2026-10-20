import db
import routes
from cache import CACHE

CACHE.warm(db.ROWS)
print(routes.handle("/products/42"))
