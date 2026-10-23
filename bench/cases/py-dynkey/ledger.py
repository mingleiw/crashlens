from refs import reference_for


def ledger_line(record):
    ref = reference_for(record, record["kind"])
    return f"{record['account']:<8} {ref:<10} {record['amount_cents'] / 100:>10.2f}"
