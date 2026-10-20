from retry import call_with_retry


def fetch_price():
    return 42


print(call_with_retry(fetch_price))
