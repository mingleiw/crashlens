import mailer


def send_welcome(profile):
    # Some sign-in providers do not share an email address.
    return mailer.send(profile["email"].lower(), f"Welcome, {profile['name']}")
