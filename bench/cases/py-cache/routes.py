from views import show_product


def handle(path):
    parts = path.strip("/").split("/")
    if parts[0] == "products" and len(parts) == 2:
        return show_product(parts[1])
    return "404"
