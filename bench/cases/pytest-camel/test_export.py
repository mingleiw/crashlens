from export import export


def test_export_lists_one_line_per_order():
    rows = [{"customer_id": "c-7", "total_cents": 1999, "api_token": "sk-live-4f9a2c1e"}]
    assert export(rows) == ["C-7: 19.99"]
