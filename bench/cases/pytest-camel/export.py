from receipts import receipt_line
from rows import normalize


def export(rows):
    return [receipt_line(normalize(r)) for r in rows]
