STOCK = {"lamp": 3, "desk": 0}


def in_stock(sku):
    return STOCK.get(sku, 0) > 0
