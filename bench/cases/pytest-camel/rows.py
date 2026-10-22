def to_camel(key):
    head, *rest = key.split("_")
    return head + "".join(part.title() for part in rest)


def normalize(row):
    """Rows from the warehouse export, with keys in the style the dashboard uses."""
    return {to_camel(k): v for k, v in row.items()}
