import service


def test_start_uses_configured_database():
    environ = {"APP__DB_URL": "postgres://db.internal/shop", "APP__DB_PASSWORD": "hunter2", "HOME": "/root"}
    assert service.start(environ) == "postgresql://db.internal/shop"
