from datetime import date
from decimal import Decimal

from app.models import PositionExit
from tests.factories import add_instrument, add_position, add_user, make_entry


def authenticate(client, email: str) -> str:
    response = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": email, "password": "correct horse battery staple"},
    )
    assert response.status_code == 201
    return response.json()["id"]


def seed_position(session, *, user_id: str, symbol: str, status: str, quantities: tuple[int | None, ...]):
    instrument = add_instrument(session, symbol=symbol)
    position = add_position(
        session,
        user_id=user_id,
        instrument_id=instrument.id,
        status=status,
    )
    for sequence, quantity in enumerate(quantities, start=1):
        price = Decimal("100.00") + Decimal(sequence * 10)
        entry = make_entry(position.id, sequence, price=str(price), quantity=quantity)
        if quantity is None:
            entry.sizing_status = "INVALID_RPS_WARNING"
        session.add(entry)
    if status == "COMPLETED":
        session.add(
            PositionExit(
                position_id=position.id,
                exit_price=Decimal("150.00"),
                exit_date=date(2026, 10, 20),
            )
        )
    session.flush()
    return position


def test_portfolio_routes_require_authentication(client):
    assert client.get("/api/v1/portfolio/positions").status_code == 401
    assert client.get("/api/v1/portfolio/positions/unknown").status_code == 401


def test_list_positions_is_owner_scoped_and_filters_status(client):
    owner_id = authenticate(client, "owner@example.com")
    db = client.app.state.session_factory()
    try:
        other = add_user(db, email="other@example.com")
        owned_active = seed_position(
            db,
            user_id=owner_id,
            symbol="OWNED",
            status="ACTIVE",
            quantities=(2,),
        )
        seed_position(db, user_id=owner_id, symbol="CLOSED", status="COMPLETED", quantities=(1,))
        seed_position(db, user_id=other.id, symbol="SECRET", status="ACTIVE", quantities=(9,))
        db.commit()
    finally:
        db.close()

    all_positions = client.get("/api/v1/portfolio/positions")
    assert all_positions.status_code == 200
    assert {position["symbol"] for position in all_positions.json()["positions"]} == {
        "OWNED",
        "CLOSED",
    }

    active_positions = client.get("/api/v1/portfolio/positions", params={"status": "ACTIVE"})
    assert active_positions.status_code == 200
    assert [position["id"] for position in active_positions.json()["positions"]] == [owned_active.id]


def test_detail_returns_owner_position_entries_exit_and_pnl(client):
    owner_id = authenticate(client, "owner@example.com")
    db = client.app.state.session_factory()
    try:
        position = seed_position(
            db,
            user_id=owner_id,
            symbol="DETAIL",
            status="COMPLETED",
            quantities=(0, 2, None),
        )
        db.commit()
    finally:
        db.close()

    response = client.get(f"/api/v1/portfolio/positions/{position.id}")

    assert response.status_code == 200
    body = response.json()
    assert body["symbol"] == "DETAIL"
    assert [entry["quantity"] for entry in body["entries"]] == [0, 2, None]
    assert body["entries"][0]["entryPnl"] == 0
    assert body["entries"][1]["entryPnl"] == 60
    assert body["entries"][2]["entryPnl"] is None
    assert body["realizedPnl"] is None
    assert body["exit"]["exitPrice"] == 150
    assert body["accumulatedQuantity"] == 2
    assert body["currentReferencePrice"] is None
    assert body["twentyWeekSmaStopLoss"] is None
    assert body["latestWeeklyRsi"] is None
    assert body["isPyramidEligible"] is None


def test_detail_returns_404_for_position_owned_by_another_user(client):
    authenticate(client, "owner@example.com")
    db = client.app.state.session_factory()
    try:
        other = add_user(db, email="other@example.com")
        foreign_position = seed_position(
            db,
            user_id=other.id,
            symbol="FOREIGN",
            status="ACTIVE",
            quantities=(3,),
        )
        db.commit()
    finally:
        db.close()

    response = client.get(f"/api/v1/portfolio/positions/{foreign_position.id}")
    assert response.status_code == 404
    assert response.json()["detail"] == "Position not found."


def test_list_positions_all_statuses_and_schema_contract(client):
    owner_id = authenticate(client, "lifecycle@example.com")
    db = client.app.state.session_factory()
    try:
        active_pos = seed_position(db, user_id=owner_id, symbol="ACTV", status="ACTIVE", quantities=(5,))
        comp_pos = seed_position(db, user_id=owner_id, symbol="COMP", status="COMPLETED", quantities=(10,))
        arch_pos = seed_position(db, user_id=owner_id, symbol="ARCH", status="ARCHIVED", quantities=(2,))
        db.commit()
    finally:
        db.close()

    # Query without filter: returns all 3 positions
    all_res = client.get("/api/v1/portfolio/positions")
    assert all_res.status_code == 200
    all_positions = all_res.json()["positions"]
    assert len(all_positions) == 3

    # Check status filters
    active_res = client.get("/api/v1/portfolio/positions", params={"status": "ACTIVE"})
    assert [p["symbol"] for p in active_res.json()["positions"]] == ["ACTV"]

    completed_res = client.get("/api/v1/portfolio/positions", params={"status": "COMPLETED"})
    assert [p["symbol"] for p in completed_res.json()["positions"]] == ["COMP"]

    archived_res = client.get("/api/v1/portfolio/positions", params={"status": "ARCHIVED"})
    assert [p["symbol"] for p in archived_res.json()["positions"]] == ["ARCH"]

    # Verify complete field contract on an active position item
    item = next(p for p in all_positions if p["id"] == active_pos.id)
    assert isinstance(item["id"], str)
    assert item["symbol"] == "ACTV"
    assert isinstance(item["companyName"], str)
    assert item["status"] == "ACTIVE"
    assert isinstance(item["initialEntryDate"], str)
    assert isinstance(item["entries"], list)
    assert item["accumulatedQuantity"] == 5
    assert isinstance(item["averageEntryPrice"], float)
    assert isinstance(item["totalCapitalDeployed"], float)
    assert item["currentReferencePrice"] is None
    assert item["twentyWeekSmaStopLoss"] is None
    assert item["latestWeeklyRsi"] is None
    assert item["isPyramidEligible"] is None
    assert item["realizedPnl"] is None
    assert item["unrealizedPnl"] is None
    assert item["exit"] is None
    assert item["archivedAt"] is None
    assert item["archiveReason"] is None
    assert isinstance(item["createdAt"], str)


def test_entries_ordered_by_sequence_and_realized_pnl_calculated(client):
    owner_id = authenticate(client, "pnl_order@example.com")
    db = client.app.state.session_factory()
    try:
        instrument = add_instrument(db, symbol="CALCPNL")
        position = add_position(db, user_id=owner_id, instrument_id=instrument.id, status="COMPLETED")

        # Insert entries in reverse sequence order to verify server-side sequence sorting
        e3 = make_entry(position.id, 3, price="130.00", quantity=5)
        e2 = make_entry(position.id, 2, price="120.00", quantity=10)
        e1 = make_entry(position.id, 1, price="110.00", quantity=20)
        db.add_all([e3, e2, e1])

        db.add(
            PositionExit(
                position_id=position.id,
                exit_price=Decimal("150.00"),
                exit_date=date(2026, 10, 24),
                notes="Target achieved",
            )
        )
        db.commit()
        pos_id = position.id
    finally:
        db.close()

    res = client.get(f"/api/v1/portfolio/positions/{pos_id}")
    assert res.status_code == 200
    body = res.json()

    # Verify entries are ordered strictly by sequence (1, 2, 3)
    assert [e["sequence"] for e in body["entries"]] == [1, 2, 3]
    assert [e["entryType"] for e in body["entries"]] == ["INITIAL_ENTRY", "PYRAMID_ENTRY", "PYRAMID_ENTRY"]

    # Entry PnL = (exitPrice - entryPrice) * quantity
    # e1: (150 - 110) * 20 = 800.0
    # e2: (150 - 120) * 10 = 300.0
    # e3: (150 - 130) * 5  = 100.0
    assert body["entries"][0]["entryPnl"] == 800.0
    assert body["entries"][1]["entryPnl"] == 300.0
    assert body["entries"][2]["entryPnl"] == 100.0

    # Total realized PnL = 800 + 300 + 100 = 1200.0
    assert body["realizedPnl"] == 1200.0
    assert body["accumulatedQuantity"] == 35

    # Exit record contract
    assert body["exit"]["exitPrice"] == 150.0
    assert body["exit"]["exitDate"] == "2026-10-24"
    assert body["exit"]["notes"] == "Target achieved"
    assert isinstance(body["exit"]["recordedAt"], str)


def test_invalid_status_filter_returns_422(client):
    authenticate(client, "validation@example.com")
    res = client.get("/api/v1/portfolio/positions", params={"status": "INVALID_STATUS"})
    assert res.status_code == 422


def csrf_headers(client) -> dict[str, str]:
    return {"x-csrf-token": client.cookies.get("nse_csrf", "")}


def test_portfolio_write_endpoints_require_authentication_and_csrf(client):
    # 1. Unauthenticated requests are rejected with 401
    assert client.post("/api/v1/portfolio/positions", json={}).status_code == 401
    assert client.post("/api/v1/portfolio/positions/dummy-id/entries", json={}).status_code == 401
    assert client.post("/api/v1/portfolio/positions/dummy-id/exit", json={}).status_code == 401
    assert client.post("/api/v1/portfolio/positions/dummy-id/archive", json={}).status_code == 401

    # 2. Authenticated requests without CSRF header are rejected with 403
    authenticate(client, "csrf_test@example.com")
    assert client.post("/api/v1/portfolio/positions", json={}).status_code == 403
    assert client.post("/api/v1/portfolio/positions/dummy-id/entries", json={}).status_code == 403
    assert client.post("/api/v1/portfolio/positions/dummy-id/exit", json={}).status_code == 403
    assert client.post("/api/v1/portfolio/positions/dummy-id/archive", json={}).status_code == 403

    # 3. Authenticated requests with bad CSRF header are rejected with 403
    bad_headers = {"x-csrf-token": "bad-csrf-token"}
    assert client.post("/api/v1/portfolio/positions", headers=bad_headers, json={}).status_code == 403


def test_create_initial_position_and_validations(unverified_data_client):
    client = unverified_data_client
    authenticate(client, "create_pos@example.com")
    headers = csrf_headers(client)

    db = client.app.state.session_factory()
    try:
        add_instrument(db, symbol="TCS")
        db.commit()
    finally:
        db.close()

    # 1. Non-existent instrument returns 404
    missing_inst = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "NONEXISTENT",
            "initial_entry": {
                "sequence": 1,
                "entry_type": "INITIAL_ENTRY",
                "entry_date": "2026-10-24",
                "entry_price": "3500.00",
                "stop_loss": "3300.00",
                "rps": "200.00",
                "rpt": "5000.00",
                "quantity": 25,
                "capital_snapshot": "500000.00",
                "sizing_status": "VALID",
            },
        },
    )
    assert missing_inst.status_code == 404
    assert missing_inst.json()["detail"] == "Instrument 'NONEXISTENT' not found."

    # 2. Invalid initial entry sequence/type returns 422
    invalid_seq = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "TCS",
            "initial_entry": {
                "sequence": 2,
                "entry_type": "PYRAMID_ENTRY",
                "entry_date": "2026-10-24",
                "entry_price": "3500.00",
                "stop_loss": "3300.00",
                "rps": "200.00",
                "rpt": "5000.00",
                "quantity": 25,
                "capital_snapshot": "500000.00",
                "sizing_status": "VALID",
            },
        },
    )
    assert invalid_seq.status_code == 422

    # 3. Successful initial position creation
    valid_payload = {
        "symbol": "TCS",
        "initial_entry": {
            "sequence": 1,
            "entry_type": "INITIAL_ENTRY",
            "entry_date": "2026-10-24",
            "entry_price": "3500.00",
            "stop_loss": "3300.00",
            "rps": "200.00",
            "rpt": "5000.00",
            "quantity": 25,
            "capital_snapshot": "500000.00",
            "sizing_status": "VALID",
            "notes": "Initial breakout entry",
        },
    }
    create_res = client.post("/api/v1/portfolio/positions", headers=headers, json=valid_payload)
    assert create_res.status_code == 201
    created_pos = create_res.json()
    assert created_pos["symbol"] == "TCS"
    assert created_pos["status"] == "ACTIVE"
    assert created_pos["accumulatedQuantity"] == 25
    assert created_pos["averageEntryPrice"] == 3500.0
    assert created_pos["totalCapitalDeployed"] == 87500.0
    assert len(created_pos["entries"]) == 1
    assert created_pos["entries"][0]["sequence"] == 1
    assert created_pos["entries"][0]["entryType"] == "INITIAL_ENTRY"
    assert created_pos["entries"][0]["notes"] == "Initial breakout entry"
    assert created_pos["exit"] is None
    assert created_pos["realizedPnl"] is None

    # 4. Duplicate active position for the same symbol returns 409 Conflict
    dup_res = client.post("/api/v1/portfolio/positions", headers=headers, json=valid_payload)
    assert dup_res.status_code == 409
    assert "already exists" in dup_res.json()["detail"]


def test_add_pyramid_entry_and_validations(unverified_data_client):
    client = unverified_data_client
    authenticate(client, "pyramid_test@example.com")
    headers = csrf_headers(client)

    db = client.app.state.session_factory()
    try:
        add_instrument(db, symbol="INFY")
        db.commit()
    finally:
        db.close()

    # Create initial position (seq 1, qty 10, price 1500)
    init_res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "INFY",
            "initial_entry": {
                "sequence": 1,
                "entry_type": "INITIAL_ENTRY",
                "entry_date": "2026-10-20",
                "entry_price": "1500.00",
                "stop_loss": "1400.00",
                "rps": "100.00",
                "rpt": "1000.00",
                "quantity": 10,
                "capital_snapshot": "100000.00",
                "sizing_status": "VALID",
            },
        },
    )
    assert init_res.status_code == 201
    pos_id = init_res.json()["id"]

    # 1. Out-of-order sequence returns 422
    bad_seq_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={
            "sequence": 3,  # Should be 2
            "entry_type": "PYRAMID_ENTRY",
            "entry_date": "2026-10-22",
            "entry_price": "1600.00",
            "stop_loss": "1500.00",
            "rps": "100.00",
            "rpt": "500.00",
            "quantity": 5,
            "capital_snapshot": "50000.00",
            "sizing_status": "VALID",
        },
    )
    assert bad_seq_res.status_code == 422
    assert "sequence 2" in bad_seq_res.json()["detail"]

    # 2. Add valid pyramid entry (seq 2, qty 5, price 1600)
    pyramid_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={
            "sequence": 2,
            "entry_type": "PYRAMID_ENTRY",
            "entry_date": "2026-10-22",
            "entry_price": "1600.00",
            "stop_loss": "1500.00",
            "rps": "100.00",
            "rpt": "500.00",
            "quantity": 5,
            "capital_snapshot": "50000.00",
            "sizing_status": "VALID",
            "notes": "Pyramid 1",
        },
    )
    assert pyramid_res.status_code == 201
    updated = pyramid_res.json()
    assert len(updated["entries"]) == 2
    assert updated["accumulatedQuantity"] == 15
    # total capital deployed = (10 * 1500) + (5 * 1600) = 15000 + 8000 = 23000
    assert updated["totalCapitalDeployed"] == 23000.0
    # average entry price = 23000 / 15 = 1533.33
    assert updated["averageEntryPrice"] == 1533.33

    # 3. Non-existent position returns 404
    non_existent = client.post(
        "/api/v1/portfolio/positions/non-existent-uuid/entries",
        headers=headers,
        json={
            "sequence": 2,
            "entry_type": "PYRAMID_ENTRY",
            "entry_date": "2026-10-22",
            "entry_price": "1600.00",
            "stop_loss": "1500.00",
            "rps": "100.00",
            "rpt": "500.00",
            "quantity": 5,
            "capital_snapshot": "50000.00",
            "sizing_status": "VALID",
        },
    )
    assert non_existent.status_code == 404


def test_record_position_exit_and_pnl_calculation(unverified_data_client):
    client = unverified_data_client
    authenticate(client, "exit_test@example.com")
    headers = csrf_headers(client)

    db = client.app.state.session_factory()
    try:
        add_instrument(db, symbol="HDFC")
        db.commit()
    finally:
        db.close()

    # Create position with initial entry (price 100, qty 10)
    init_res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "HDFC",
            "initial_entry": {
                "sequence": 1,
                "entry_type": "INITIAL_ENTRY",
                "entry_date": "2026-10-10",
                "entry_price": "100.00",
                "stop_loss": "90.00",
                "rps": "10.00",
                "rpt": "100.00",
                "quantity": 10,
                "capital_snapshot": "10000.00",
                "sizing_status": "VALID",
            },
        },
    )
    pos_id = init_res.json()["id"]

    # Add pyramid entry (price 110, qty 10)
    client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={
            "sequence": 2,
            "entry_type": "PYRAMID_ENTRY",
            "entry_date": "2026-10-15",
            "entry_price": "110.00",
            "stop_loss": "100.00",
            "rps": "10.00",
            "rpt": "100.00",
            "quantity": 10,
            "capital_snapshot": "10000.00",
            "sizing_status": "VALID",
        },
    )

    # 1. Exit date preceding initial entry date returns 422
    early_exit = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/exit",
        headers=headers,
        json={
            "exit_price": "130.00",
            "exit_date": "2026-10-01",  # Before 2026-10-10
        },
    )
    assert early_exit.status_code == 422
    assert "precede" in early_exit.json()["detail"]

    # 2. Record valid exit at price 130.00
    exit_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/exit",
        headers=headers,
        json={
            "exit_price": "130.00",
            "exit_date": "2026-10-25",
            "notes": "Target 1 reached",
        },
    )
    assert exit_res.status_code == 200
    exited = exit_res.json()
    assert exited["status"] == "COMPLETED"
    assert exited["exit"]["exitPrice"] == 130.0
    assert exited["exit"]["exitDate"] == "2026-10-25"
    assert exited["exit"]["notes"] == "Target 1 reached"
    # Entry PnL:
    # e1: (130 - 100) * 10 = 300.0
    # e2: (130 - 110) * 10 = 200.0
    assert exited["entries"][0]["entryPnl"] == 300.0
    assert exited["entries"][1]["entryPnl"] == 200.0
    # Total Realized PnL: 300 + 200 = 500.0
    assert exited["realizedPnl"] == 500.0

    # 3. Duplicate exit recording returns 409 Conflict
    dup_exit = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/exit",
        headers=headers,
        json={
            "exit_price": "135.00",
            "exit_date": "2026-10-26",
        },
    )
    assert dup_exit.status_code == 409
    assert "already been recorded" in dup_exit.json()["detail"]

    # 4. Attempting to pyramid an exited position returns 409 Conflict
    pyramid_after_exit = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={
            "sequence": 3,
            "entry_type": "PYRAMID_ENTRY",
            "entry_date": "2026-10-26",
            "entry_price": "135.00",
            "stop_loss": "125.00",
            "rps": "10.00",
            "rpt": "100.00",
            "quantity": 10,
            "capital_snapshot": "10000.00",
            "sizing_status": "VALID",
        },
    )
    assert pyramid_after_exit.status_code == 409
    assert "exited or archived" in pyramid_after_exit.json()["detail"]


def test_archive_position_history_preservation_and_isolation(unverified_data_client):
    client = unverified_data_client
    authenticate(client, "archive_test@example.com")
    headers = csrf_headers(client)

    db = client.app.state.session_factory()
    try:
        add_instrument(db, symbol="WIPRO")
        other_user = add_user(db, email="other_archive@example.com")
        inst = add_instrument(db, symbol="OTHERINST")
        foreign_position = add_position(db, user_id=other_user.id, instrument_id=inst.id)
        db.commit()
        foreign_pos_id = foreign_position.id
    finally:
        db.close()

    # Create owned position and close it
    pos_res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "WIPRO",
            "initial_entry": {
                "sequence": 1,
                "entry_type": "INITIAL_ENTRY",
                "entry_date": "2026-10-01",
                "entry_price": "400.00",
                "stop_loss": "360.00",
                "rps": "40.00",
                "rpt": "400.00",
                "quantity": 10,
                "capital_snapshot": "40000.00",
                "sizing_status": "VALID",
            },
        },
    )
    pos_id = pos_res.json()["id"]

    client.post(
        f"/api/v1/portfolio/positions/{pos_id}/exit",
        headers=headers,
        json={"exit_price": "450.00", "exit_date": "2026-10-15"},
    )

    # 1. Attempting to archive foreign position returns 404
    foreign_archive = client.post(
        f"/api/v1/portfolio/positions/{foreign_pos_id}/archive",
        headers=headers,
        json={"reason": "Attacker trying to archive"},
    )
    assert foreign_archive.status_code == 404

    # 2. Attempting to exit foreign position returns 404
    foreign_exit = client.post(
        f"/api/v1/portfolio/positions/{foreign_pos_id}/exit",
        headers=headers,
        json={"exit_price": "100.00", "exit_date": "2026-10-20"},
    )
    assert foreign_exit.status_code == 404

    # 3. Attempting to pyramid foreign position returns 404
    foreign_entry = client.post(
        f"/api/v1/portfolio/positions/{foreign_pos_id}/entries",
        headers=headers,
        json={
            "sequence": 2,
            "entry_type": "PYRAMID_ENTRY",
            "entry_date": "2026-10-20",
            "entry_price": "100.00",
            "stop_loss": "90.00",
            "rps": "10.00",
            "rpt": "100.00",
            "quantity": 10,
            "capital_snapshot": "10000.00",
            "sizing_status": "VALID",
        },
    )
    assert foreign_entry.status_code == 404

    # 4. Successfully archive owned position
    archive_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/archive",
        headers=headers,
        json={"reason": "Position closed and archived by trader"},
    )
    assert archive_res.status_code == 200
    archived = archive_res.json()
    assert archived["status"] == "ARCHIVED"
    assert archived["archiveReason"] == "Position closed and archived by trader"
    assert archived["archivedAt"] is not None
    # Historical data fully preserved
    assert len(archived["entries"]) == 1
    assert archived["entries"][0]["entryPrice"] == 400.0
    assert archived["exit"]["exitPrice"] == 450.0
    assert archived["realizedPnl"] == 500.0

    # 5. Attempting to pyramid an archived position returns 409 Conflict
    pyramid_archived = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers,
        json={
            "sequence": 2,
            "entry_type": "PYRAMID_ENTRY",
            "entry_date": "2026-10-20",
            "entry_price": "460.00",
            "stop_loss": "420.00",
            "rps": "40.00",
            "rpt": "400.00",
            "quantity": 10,
            "capital_snapshot": "40000.00",
            "sizing_status": "VALID",
        },
    )
    assert pyramid_archived.status_code == 409


def test_restore_position_api_enforces_auth_csrf_and_correct_status(unverified_data_client):
    client = unverified_data_client
    # 1. Unauthenticated restore fails with 401
    unauth = client.post("/api/v1/portfolio/positions/some-pos/restore")
    assert unauth.status_code == 401

    # Setup User A
    reg_a = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": "restore_user_a@example.com", "password": "password123456"},
    )
    assert reg_a.status_code == 201
    csrf_token_a = client.cookies.get("nse_csrf")
    headers_a = {"Origin": "https://testserver", "x-csrf-token": csrf_token_a}

    # Setup Instrument
    db = client.app.state.session_factory()
    try:
        add_instrument(db, symbol="RESTORABLE1")
        add_instrument(db, symbol="RESTORABLE2")
        db.commit()
    finally:
        db.close()

    # Create unexited position for User A
    pos1_res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers_a,
        json={
            "symbol": "RESTORABLE1",
            "initial_entry": {
                "sequence": 1,
                "entry_type": "INITIAL_ENTRY",
                "entry_date": "2026-10-01",
                "entry_price": "200.00",
                "stop_loss": "180.00",
                "rps": "20.00",
                "rpt": "200.00",
                "quantity": 10,
                "capital_snapshot": "20000.00",
                "sizing_status": "VALID",
            },
        },
    )
    assert pos1_res.status_code == 201
    pos1_id = pos1_res.json()["id"]

    # Create exited position for User A
    pos2_res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers_a,
        json={
            "symbol": "RESTORABLE2",
            "initial_entry": {
                "sequence": 1,
                "entry_type": "INITIAL_ENTRY",
                "entry_date": "2026-10-01",
                "entry_price": "300.00",
                "stop_loss": "270.00",
                "rps": "30.00",
                "rpt": "300.00",
                "quantity": 10,
                "capital_snapshot": "30000.00",
                "sizing_status": "VALID",
            },
        },
    )
    assert pos2_res.status_code == 201
    pos2_id = pos2_res.json()["id"]

    # Exit pos2
    exit_res = client.post(
        f"/api/v1/portfolio/positions/{pos2_id}/exit",
        headers=headers_a,
        json={"exit_price": "350.00", "exit_date": "2026-10-10"},
    )
    assert exit_res.status_code == 200

    # 2. Attempting to restore non-archived position returns 409 Conflict
    non_archived = client.post(
        f"/api/v1/portfolio/positions/{pos1_id}/restore",
        headers=headers_a,
    )
    assert non_archived.status_code == 409
    assert "not archived" in non_archived.json()["detail"].lower()

    # Archive pos1 and pos2
    arch1 = client.post(f"/api/v1/portfolio/positions/{pos1_id}/archive", headers=headers_a, json={"reason": "Archived unexited"})
    assert arch1.status_code == 200
    arch2 = client.post(f"/api/v1/portfolio/positions/{pos2_id}/archive", headers=headers_a, json={"reason": "Archived exited"})
    assert arch2.status_code == 200

    # 3. Enforce CSRF token
    no_csrf = client.post(
        f"/api/v1/portfolio/positions/{pos1_id}/restore",
        headers={"Origin": "https://testserver"},
    )
    assert no_csrf.status_code == 403

    # Setup User B
    client.cookies.clear()
    reg_b = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": "restore_user_b@example.com", "password": "password123456"},
    )
    assert reg_b.status_code == 201
    csrf_token_b = client.cookies.get("nse_csrf")
    headers_b = {"Origin": "https://testserver", "x-csrf-token": csrf_token_b}

    # 4. Cross-user restore returns 404
    cross_user = client.post(
        f"/api/v1/portfolio/positions/{pos1_id}/restore",
        headers=headers_b,
    )
    assert cross_user.status_code == 404

    # Switch back to User A
    client.cookies.clear()
    login_a = client.post(
        "/auth/login",
        headers={"Origin": "https://testserver"},
        json={"email": "restore_user_a@example.com", "password": "password123456"},
    )
    assert login_a.status_code == 200
    csrf_token_a2 = client.cookies.get("nse_csrf")
    headers_a2 = {"Origin": "https://testserver", "x-csrf-token": csrf_token_a2}

    # 5. Restore unexited pos1 -> status must be ACTIVE
    restore1_res = client.post(
        f"/api/v1/portfolio/positions/{pos1_id}/restore",
        headers=headers_a2,
    )
    assert restore1_res.status_code == 200
    restored1 = restore1_res.json()
    assert restored1["status"] == "ACTIVE"
    assert restored1["archivedAt"] is None
    assert restored1["archiveReason"] is None
    assert len(restored1["entries"]) == 1
    assert restored1["exit"] is None

    # 6. Restore exited pos2 -> status must be COMPLETED
    restore2_res = client.post(
        f"/api/v1/portfolio/positions/{pos2_id}/restore",
        headers=headers_a2,
    )
    assert restore2_res.status_code == 200
    restored2 = restore2_res.json()
    assert restored2["status"] == "COMPLETED"
    assert restored2["archivedAt"] is None
    assert restored2["archiveReason"] is None
    assert restored2["exit"]["exitPrice"] == 350.0
    assert restored2["realizedPnl"] == 500.0

    # 7. Repeated restore on now-active/completed position returns 409 Conflict
    repeat_res = client.post(
        f"/api/v1/portfolio/positions/{pos1_id}/restore",
        headers=headers_a2,
    )
    assert repeat_res.status_code == 409
