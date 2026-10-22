SENT = []


def send(to, subject):
    SENT.append((to, subject))
    return f"sent '{subject}' to {to}"
