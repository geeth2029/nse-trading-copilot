import anyio


def test_health_endpoint_and_openapi_docs(client):
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 200


def test_startup_does_not_create_tables_without_explicit_migration(tmp_path):
    from sqlalchemy import inspect

    from app.core.config import Settings
    from app.database.session import make_engine
    from app.main import create_app

    database_url = f"sqlite:///{(tmp_path / 'unmigrated.db').as_posix()}"
    app = create_app(Settings(database_url=database_url))

    async def lifespan_check():
        async with app.router.lifespan_context(app):
            pass

    anyio.run(lifespan_check)

    engine = make_engine(database_url)
    try:
        assert inspect(engine).get_table_names() == []
    finally:
        engine.dispose()