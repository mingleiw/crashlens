import json

# Response body of GET /v2/orders?status=paid, as returned by the storefront API.
SAMPLE = """[
  {"orderId": "o-1001", "customerId": "c-7", "total": 42.0, "currency": "USD"},
  {"orderId": "o-1002", "customerId": "c-9", "total": 18.5, "currency": "USD"}
]"""


def fetch_paid_orders():
    return json.loads(SAMPLE)
