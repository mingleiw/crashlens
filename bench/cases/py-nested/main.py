import json

import events
from welcome import send_welcome

with open("samples/signup_event.json") as f:
    profile = events.parse_signup(json.load(f))
print(send_welcome(profile))
