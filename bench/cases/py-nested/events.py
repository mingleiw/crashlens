def parse_signup(event):
    user = event.get("user", {})
    return {
        "id": user.get("id"),
        "email": user.get("email"),
        "name": user.get("name"),
    }
