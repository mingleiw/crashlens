from pricing import format_price


def product_page(product):
    return f"<h1>{product.name}</h1><p>{format_price(product.price)}</p>"
