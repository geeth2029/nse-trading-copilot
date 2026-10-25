from datetime import date
from decimal import Decimal

from tests.factories import add_instrument


def test_authenticated_portfolio_full_lifecycle_e2e(unverified_data_client):
    client = unverified_data_client
    """End-to-end verification of the full authenticated lifecycle using an isolated temporary database.
    
    Verifies:
    1. Registration & session authentication
    2. Initial portfolio empty state
    3. Initial position creation & persistence across requests
    4. Sizing snapshot integrity & multi-entry pyramiding
    5. Single-exit recording, status transition to COMPLETED, and P&L calculation
    6. Single Position Exit Rule enforcement (rejecting duplicate exits)
    7. Soft-archiving with audit trail preservation
    8. Filtering active vs archived positions
    9. Restoration back to COMPLETED status
    10. Cross-user isolation & access denial
    11. Logout and session invalidation
    """
    # Step 1: Register User A and User B
    reg_a = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": "trader_a@example.com", "password": "SecurePassword123!"},
    )
    assert reg_a.status_code == 201
    user_a_id = reg_a.json()["id"]
    csrf_a = client.cookies.get("nse_csrf")
    assert csrf_a is not None
    headers_a = {"Origin": "https://testserver", "x-csrf-token": csrf_a}

    # Seed required Instruments in the isolated test DB
    db = client.app.state.session_factory()
    try:
        inst_infy = add_instrument(db, symbol="INFY")
        inst_tcs = add_instrument(db, symbol="TCS")
        db.commit()
    finally:
        db.close()

    # Step 2: User A verifies empty portfolio
    list_empty = client.get("/api/v1/portfolio/positions")
    assert list_empty.status_code == 200
    assert list_empty.json()["positions"] == []

    # Step 3: Create initial position for INFY
    # Entry price 1950.00, stop loss 1800.00, rps 150.00, rpt 5000.00, quantity 33, capital 500000.00
    create_res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers_a,
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
                "notes": "Initial trade entry on breakout",
            },
        },
    )
    assert create_res.status_code == 201
    pos_id = create_res.json()["id"]
    assert pos_id is not None
    assert create_res.json()["status"] == "ACTIVE"
    assert create_res.json()["accumulatedQuantity"] == 33
    assert create_res.json()["averageEntryPrice"] == 1950.0
    assert create_res.json()["totalCapitalDeployed"] == 64350.0  # 1950 * 33

    # Verify persistence: re-fetch via GET /api/v1/portfolio/positions
    persisted_list = client.get("/api/v1/portfolio/positions")
    assert persisted_list.status_code == 200
    positions = persisted_list.json()["positions"]
    assert len(positions) == 1
    assert positions[0]["id"] == pos_id
    assert positions[0]["symbol"] == "INFY"
    assert positions[0]["status"] == "ACTIVE"
    assert len(positions[0]["entries"]) == 1
    assert positions[0]["entries"][0]["sequence"] == 1
    assert positions[0]["entries"][0]["entryPrice"] == 1950.0
    assert positions[0]["entries"][0]["stopLoss"] == 1800.0
    assert positions[0]["entries"][0]["quantity"] == 33
    assert positions[0]["exit"] is None

    # Step 4: Add Pyramid Entry (Sequence 2)
    # Entry price 2000.00, stop loss 1850.00, rps 150.00, rpt 5000.00, quantity 33
    pyramid_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers_a,
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
            "notes": "Pyramid entry #1 following trend",
        },
    )
    assert pyramid_res.status_code == 201
    pyramided = pyramid_res.json()
    assert pyramided["accumulatedQuantity"] == 66  # 33 + 33
    assert pyramided["averageEntryPrice"] == 1975.0  # (1950*33 + 2000*33) / 66
    assert pyramided["totalCapitalDeployed"] == 130350.0  # 64350 + 66000
    assert len(pyramided["entries"]) == 2

    # Step 5: Record Exit for the entire accumulated position
    # Exit price 2100.00 on 2026-10-20
    exit_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/exit",
        headers=headers_a,
        json={
            "exit_price": "2100.00",
            "exit_date": "2026-10-20",
            "notes": "Full target exit achieved",
        },
    )
    assert exit_res.status_code == 200
    exited = exit_res.json()
    assert exited["status"] == "COMPLETED"
    assert exited["exit"] is not None
    assert exited["exit"]["exitPrice"] == 2100.0
    assert exited["exit"]["exitDate"] == "2026-10-20"
    # Entry 1 P&L: (2100 - 1950) * 33 = 150 * 33 = 4950.0
    # Entry 2 P&L: (2100 - 2000) * 33 = 100 * 33 = 3300.0
    # Total Realized P&L: 4950 + 3300 = 8250.0
    assert exited["entries"][0]["entryPnl"] == 4950.0
    assert exited["entries"][1]["entryPnl"] == 3300.0
    assert exited["realizedPnl"] == 8250.0

    # Step 6: Single Position Exit Rule enforcement
    # Attempting to record a second exit must fail with 409 Conflict
    dup_exit = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/exit",
        headers=headers_a,
        json={"exit_price": "2150.00", "exit_date": "2026-10-22"},
    )
    assert dup_exit.status_code == 409
    assert "already been recorded" in dup_exit.json()["detail"]

    # Attempting to add a pyramid entry to an exited position must fail with 409 Conflict
    pyramid_exited = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/entries",
        headers=headers_a,
        json={
            "sequence": 3,
            "entry_type": "PYRAMID_ENTRY",
            "entry_date": "2026-10-22",
            "entry_price": "2150.00",
            "stop_loss": "2000.00",
            "rps": "150.00",
            "rpt": "5000.00",
            "quantity": 33,
            "capital_snapshot": "500000.00",
            "sizing_status": "VALID",
        },
    )
    assert pyramid_exited.status_code == 409

    # Step 7: Archive the completed position
    archive_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/archive",
        headers=headers_a,
        json={"reason": "Profitable swing trade closed and archived"},
    )
    assert archive_res.status_code == 200
    archived = archive_res.json()
    assert archived["status"] == "ARCHIVED"
    assert archived["archiveReason"] == "Profitable swing trade closed and archived"
    assert archived["archivedAt"] is not None
    # All entries, exits, quantities, and P&L permanently preserved
    assert len(archived["entries"]) == 2
    assert archived["accumulatedQuantity"] == 66
    assert archived["realizedPnl"] == 8250.0
    assert archived["exit"]["exitPrice"] == 2100.0

    # Step 8: Status filtering
    # Active-only list must exclude the archived position
    active_list = client.get("/api/v1/portfolio/positions", params={"status": "ACTIVE"})
    assert active_list.status_code == 200
    assert active_list.json()["positions"] == []

    # Completed-only list query
    completed_list = client.get("/api/v1/portfolio/positions", params={"status": "COMPLETED"})
    assert completed_list.status_code == 200
    assert completed_list.json()["positions"] == []

    # Full list contains the archived position
    full_list = client.get("/api/v1/portfolio/positions")
    assert full_list.status_code == 200
    assert len(full_list.json()["positions"]) == 1
    assert full_list.json()["positions"][0]["status"] == "ARCHIVED"

    # Step 9: Restore the archived position
    # Since an exit exists, it must restore to COMPLETED
    restore_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/restore",
        headers=headers_a,
    )
    assert restore_res.status_code == 200
    restored = restore_res.json()
    assert restored["status"] == "COMPLETED"
    assert restored["archivedAt"] is None
    assert restored["archiveReason"] is None
    assert restored["exit"]["exitPrice"] == 2100.0
    assert restored["realizedPnl"] == 8250.0
    assert len(restored["entries"]) == 2

    # Step 10: Cross-user access isolation
    # Register and authenticate User B
    client.cookies.clear()
    reg_b = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": "trader_b@example.com", "password": "SecurePassword123!"},
    )
    assert reg_b.status_code == 201
    csrf_b = client.cookies.get("nse_csrf")
    headers_b = {"Origin": "https://testserver", "x-csrf-token": csrf_b}

    # User B views portfolio: sees 0 positions (cannot see User A's position)
    user_b_list = client.get("/api/v1/portfolio/positions")
    assert user_b_list.status_code == 200
    assert user_b_list.json()["positions"] == []

    # User B attempts to read User A's position -> 404
    foreign_read = client.get(f"/api/v1/portfolio/positions/{pos_id}")
    assert foreign_read.status_code == 404

    # User B attempts to exit User A's position -> 404
    foreign_exit = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/exit",
        headers=headers_b,
        json={"exit_price": "2200.00", "exit_date": "2026-10-25"},
    )
    assert foreign_exit.status_code == 404

    # User B attempts to archive User A's position -> 404
    foreign_archive = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/archive",
        headers=headers_b,
        json={"reason": "Unauthorized archive"},
    )
    assert foreign_archive.status_code == 404

    # User B attempts to restore User A's position -> 404
    foreign_restore = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/restore",
        headers=headers_b,
    )
    assert foreign_restore.status_code == 404

    # Step 11: Logout User B and verify session termination
    logout_b = client.post("/auth/logout", headers=headers_b)
    assert logout_b.status_code == 200
    assert logout_b.json()["status"] == "logged_out"

    # Subsequent request with old session returns 401
    post_logout = client.get("/api/v1/portfolio/positions")
    assert post_logout.status_code == 401


def test_authenticated_unexited_position_lifecycle_e2e(unverified_data_client):
    client = unverified_data_client
    """Verifies that an unexited position restores as ACTIVE, and that duplicate active positions are prevented."""
    # Register & login user
    reg = client.post(
        "/auth/register",
        headers={"Origin": "https://testserver"},
        json={"email": "trader_unexited@example.com", "password": "Password12345!"},
    )
    assert reg.status_code == 201
    csrf = client.cookies.get("nse_csrf")
    headers = {"Origin": "https://testserver", "x-csrf-token": csrf}

    db = client.app.state.session_factory()
    try:
        add_instrument(db, symbol="RELIANCE")
        db.commit()
    finally:
        db.close()

    # Create unexited active position
    create_res = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "RELIANCE",
            "initial_entry": {
                "sequence": 1,
                "entry_type": "INITIAL_ENTRY",
                "entry_date": "2026-10-05",
                "entry_price": "2900.00",
                "stop_loss": "2700.00",
                "rps": "200.00",
                "rpt": "5000.00",
                "quantity": 25,
                "capital_snapshot": "500000.00",
                "sizing_status": "VALID",
            },
        },
    )
    assert create_res.status_code == 201
    pos_id = create_res.json()["id"]

    # Archive without exit
    arch_res = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/archive",
        headers=headers,
        json={"reason": "Temporarily archived active position"},
    )
    assert arch_res.status_code == 200
    assert arch_res.json()["status"] == "ARCHIVED"

    # While pos_id is archived, user opens a NEW active position for RELIANCE
    create_new = client.post(
        "/api/v1/portfolio/positions",
        headers=headers,
        json={
            "symbol": "RELIANCE",
            "initial_entry": {
                "sequence": 1,
                "entry_type": "INITIAL_ENTRY",
                "entry_date": "2026-10-15",
                "entry_price": "2950.00",
                "stop_loss": "2750.00",
                "rps": "200.00",
                "rpt": "5000.00",
                "quantity": 25,
                "capital_snapshot": "500000.00",
                "sizing_status": "VALID",
            },
        },
    )
    assert create_new.status_code == 201
    new_pos_id = create_new.json()["id"]

    # Now attempt to restore pos_id (unexited) -> must fail with 409 because an active position already exists for RELIANCE
    blocked_restore = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/restore",
        headers=headers,
    )
    assert blocked_restore.status_code == 409
    assert "active position already exists for RELIANCE" in blocked_restore.json()["detail"]

    # Now exit the second position so it becomes COMPLETED
    exit_second = client.post(
        f"/api/v1/portfolio/positions/{new_pos_id}/exit",
        headers=headers,
        json={"exit_price": "3100.00", "exit_date": "2026-10-20"},
    )
    assert exit_second.status_code == 200

    # Now restore pos_id: should succeed and transition to ACTIVE
    success_restore = client.post(
        f"/api/v1/portfolio/positions/{pos_id}/restore",
        headers=headers,
    )
    assert success_restore.status_code == 200
    assert success_restore.json()["status"] == "ACTIVE"
    assert success_restore.json()["exit"] is None
