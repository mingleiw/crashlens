from importer import load_records
from ledger import ledger_line

for record in load_records():
    print(ledger_line(record))
