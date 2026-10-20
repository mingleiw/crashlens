from datetime import datetime, timezone

import queue_lib


def submit_ticket(ticket_id, priority):
    queue_lib.publish({
        "ticket_id": ticket_id,
        "priority": priority,
        "created_at": datetime.now(timezone.utc),
    })
