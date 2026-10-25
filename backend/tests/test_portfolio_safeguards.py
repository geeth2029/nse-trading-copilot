from datetime import date
from decimal import Decimal

from app.models import PositionExit
from tests.factories import add_instrument, add_position, add_user, make_entry


def test_authenticated_creation_blocked_by_default(client):
    """Direct API request to create position is rejected with 403 when unverified market data is disabled."""
    # Register & get CSRF token
    reg = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": "trader_safeguard@example.com", "password": "Password123!"},
    )
    assert reg.status_code == 201
    csrf = client.cookies.get("nse_csrf")
    headers = {"Origin": "https://testserver", "x-csrf-token": csrf}

    db = client.app.state.session_factory()
    try:
        add_instrument(db, symbol="INFY")
        db.commit()
    finally:
        db.close()

    # Direct API request to create position
    res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "INFY",
            "initial_entry": {
                "sequence": 1,
                "entry_type": "INITIAL_ENTRY",
                "entry_date": "2026-10-01",
                "entry_price": "1950.00",
                "stop_loss": "1800.00",
                "rps": "150.00",
                "rpt": "5000.00",
                "quantity": 33,
                "capital_snapshot": "500000.00",
                "sizing_status": "VALID",
            },
        },
    )
    assert res.status_code == 403
    assert "verified NSE market data has not been connected" in res.json()["detail"]

    # Verify no position or trade entries were created in the database
    positions_list = client.get("/api/v1/portfolio/positions")
    assert positions_list.status_code == 200
    assert positions_list.json()["positions"] == []


def test_authenticated_pyramiding_blocked_by_default(client):
    """Direct API request to add pyramid entry is rejected with 403 when unverified market data is disabled."""
    reg = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": "trader_pyramid_guard@example.com", "password": "Password123!"},
    )
    assert reg.status_code == 201
    user_id = reg.json()["id"]
    csrf = client.cookies.get("nse_csrf")
    headers = {"Origin": "https://testserver", "x-csrf-token": csrf}

    # Seed an existing active position directly in DB
    db = client.app.state.session_factory()
    try:
        inst = add_instrument(db, symbol="INFY")
        pos = add_position(db, user_id=user_id, instrument_id=inst.id, status="ACTIVE")
        entry = make_entry(pos.id, 1, price="1950.00", quantity=33)
        db.add(entry)
        db.commit()
        pos_id = pos.id
    finally:
        db.close()

    # Attempt to add pyramid entry
    res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={
            "sequence": 2,
            "entry_type": "PYRAMID_ENTRY",
            "entry_date": "2026-10-10",
            "entry_price": "2000.00",
            "stop_loss": "1850.00",
            "rps": "150.00",
            "rpt": "5000.00",
            "quantity": 33,
            "capital_snapshot": "500000.00",
            "sizing_status": "VALID",
        },
    )
    assert res.status_code == 403
    assert "verified NSE market data has not been connected" in res.json()["detail"]

    # Verify no second entry was added to the position
    detail = client.get(f"/api/v1/portfolio/positions/{pos_id}")
    assert detail.status_code == 200
    assert len(detail.json()["entries"]) == 1


def test_existing_position_operations_remain_available_when_writes_blocked(client):
    """Existing positions can still be read, exited, archived, and restored even while unverified entry writes are blocked."""
    reg = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": "trader_existing@example.com", "password": "Password123!"},
    )
    assert reg.status_code == 201
    user_id = reg.json()["id"]
    csrf = client.cookies.get("nse_csrf")
    headers = {"Origin": "https://testserver", "x-csrf-token": csrf}

    # Seed an existing active position in the DB
    db = client.app.state.session_factory()
    try:
        inst = add_instrument(db, symbol="TCS")
        pos = add_position(db, user_id=user_id, instrument_id=inst.id, status="ACTIVE")
        entry = make_entry(pos.id, 1, price="4000.00", quantity=10)
        db.add(entry)
        db.commit()
        pos_id = pos.id
    finally:
        db.close()

    # 1. Read position is allowed
    read_res = client.get(f"/api/v1/portfolio/positions/{pos_id}")
    assert read_res.status_code == 200
    assert read_res.json()["status"] == "ACTIVE"

    # 2. Record Exit is allowed
    exit_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/exit",
        headers=headers,
        json={"exit_price": "4200.00", "exit_date": "2026-10-20"},
    )
    assert exit_res.status_code == 200
    assert exit_res.json()["status"] == "COMPLETED"
    assert exit_res.json()["realizedPnl"] == 2000.0

    # 3. Archive position is allowed
    arch_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/archive",
        headers=headers,
        json={"reason": "Trade closed and archived"},
    )
    assert arch_res.status_code == 200
    assert arch_res.json()["status"] == "ARCHIVED"

    # 4. Restore position is allowed
    rest_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/restore",
        headers=headers,
    )
    assert rest_res.status_code == 200
    assert rest_res.json()["status"] == "COMPLETED"


def test_explicit_test_only_opt_in_allows_isolated_lifecycle_tests(unverified_data_client):
    """Isolated test client with explicit opt-in can test calculations and lifecycle transitions."""
    reg = unverified_data_client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": "trader_optin@example.com", "password": "Password123!"},
    )
    assert reg.status_code == 201
    csrf = unverified_data_client.cookies.get("nse_csrf")
    headers = {"Origin": "https://testserver", "x-csrf-token": csrf}

    db = unverified_data_client.app.state.session_factory()
    try:
        add_instrument(db, symbol="INFY")
        db.commit()
    finally:
        db.close()

    # Position creation succeeds under explicit opt-in test configuration
    create_res = unverified_data_client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "INFY",
            "initial_entry": {
                "sequence": 1,
                "entry_type": "INITIAL_ENTRY",
                "entry_date": "2026-10-01",
                "entry_price": "1950.00",
                "stop_loss": "1800.00",
                "rps": "150.00",
                "rpt": "5000.00",
                "quantity": 33,
                "capital_snapshot": "500000.00",
                "sizing_status": "VALID",
            },
        },
    )
    assert create_res.status_code == 201
    assert create_res.json()["status"] == "ACTIVE"
