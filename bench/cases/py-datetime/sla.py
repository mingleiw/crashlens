from datetime import timedelta

WINDOWS = {"high": timedelta(hours=4), "normal": timedelta(days=1)}


def deadline(job):
    return job["created_at"] + WINDOWS[job["priority"]]
