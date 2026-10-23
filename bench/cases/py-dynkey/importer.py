import csv
import io

EXPORT = """account,kind,billing_reference,invoice_reference,amount_cents
acme,billing,BL-2207,INV-9911,129900
"""


def load_records():
    rows = []
    for row in csv.DictReader(io.StringIO(EXPORT)):
        rows.append({
            "account": row["account"],
            "kind": row["kind"],
            "billing_reference": row["billing_reference"],
            "invoice_reference": row["invoice_reference"],
            "amount_cents": int(row["amount_cents"]),
        })
    return rows
