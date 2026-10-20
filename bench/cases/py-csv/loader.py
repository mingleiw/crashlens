def load(path):
    with open(path) as f:
        lines = [line.strip() for line in f if line.strip()]
    header = lines[0].split(",")
    rows = []
    for line in lines[1:]:
        values = line.split(",")
        rows.append(dict(zip(header, values[1:])))
    return rows
