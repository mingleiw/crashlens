from cache import CACHE
from render import product_page


def show_product(product_id):
    # Products removed from the catalog are evicted, so this can come back empty.
    product = CACHE.get(product_id)
    return product_page(product)
