from dataclasses import dataclass


@dataclass
class Product:
    id: int
    name: str
    price: float


class ProductCache:
    def __init__(self):
        self._items = {}

    def warm(self, rows):
        self._items = {row["id"]: Product(**row) for row in rows}

    def get(self, product_id):
        return self._items.get(product_id)


CACHE = ProductCache()
