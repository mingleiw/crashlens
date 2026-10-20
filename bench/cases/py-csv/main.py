import loader
import report

rows = loader.load("orders.csv")
print("total: %.2f" % report.summary(rows))
