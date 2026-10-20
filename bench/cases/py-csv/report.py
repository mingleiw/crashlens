def line_total(row):
    return float(row["price"]) * int(row["qty"])


def summary(rows):
    return sum(line_total(r) for r in rows)
