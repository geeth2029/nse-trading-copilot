# NSE Trading Copilot Backend

This is a standalone FastAPI backend foundation. It includes minimal local-development authentication, but does not connect to the frontend, retrieve market data, or place broker orders. Portfolio HTTP routes are intentionally not exposed yet.

Future portfolio endpoints must derive the owner ID from the authenticated server-side principal and must never trust a client-supplied `user_id`. Entry calculation snapshots have no approved edit workflow; the service permits notes-only changes and rejects attempts to change recorded entry fields.

## Requirements

- Python 3.12.3
- PowerShell on Windows

## Create the environment

From the project root:

```powershell
py -3.12 -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install --upgrade pip
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
```

Activate it in PowerShell:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
```

## Run tests

From `backend/` with the environment active:

```powershell
pytest
```

## Database migrations

Alembic owns schema creation and evolution. Application startup does not call `create_all()`; initialize a fresh database with an explicit migration before starting the API.

From `backend/` with the environment active:

```powershell
alembic revision --autogenerate -m "describe schema change"
```

Inspect the generated file under `alembic/versions/` before applying it. Confirm every operation matches the model change, preserves constraints/indexes, and contains no unintended table or column drops. Autogeneration is a proposal, not an approval step.

```powershell
alembic upgrade head
alembic current
alembic history
```

To render a SQL preview without applying it, use `alembic upgrade head --sql`. To use another database, set `DATABASE_URL` in `backend/.env` or in the process environment before running Alembic. SQLite foreign keys and path handling use the same `make_engine()` configuration as the application.

### Existing local database safety

The initial migration is intended for an empty database. Do not run `alembic upgrade head` against a database that already has tables from the former `create_all()` startup path: the initial migration creates those tables and is not an automatic adoption migration. First make a verified backup, compare the existing schema with the reviewed initial migration, and test the procedure against a copy. Only if the schema is confirmed identical should an operator consider `alembic stamp head` to register that existing schema without applying DDL. Do not stamp a database whose schema has not been verified.

The existing `backend/data/nse_trading_copilot.db` was inspected read-only during this setup: it has the five application tables and no `alembic_version` table, matching the old `create_all()` path. It was not stamped, migrated, copied over, deleted, or recreated. Until an operator verifies and adopts that database, startup will not create or migrate its schema automatically. Use a fresh database for the documented `alembic upgrade head` workflow.

The auth-session table is introduced by the second revision (`670bf16a5ea0`). Auth routes require that revision. The existing local database was not migrated in this task; use a fresh isolated database or complete the documented backup/schema verification and adoption process before using authentication with it.

## Start the API

From `backend/` with the environment active:

```powershell
uvicorn app.main:app --reload
```

The health endpoint is at `http://127.0.0.1:8000/health`. Interactive OpenAPI documentation is at `http://127.0.0.1:8000/docs`, with ReDoc at `http://127.0.0.1:8000/redoc`.

Run `alembic upgrade head` once to create SQLite tables under `backend/data/`. Set `DATABASE_URL` in a local `.env` file to override the default. Local environment files and database files are excluded from Git.

## Local authentication foundation

Registration is disabled by default. To enable it for a private local development instance, set `REGISTRATION_ENABLED=true` in `backend/.env`. For loopback HTTP-only development, set `SESSION_COOKIE_SECURE=false`; keep it `true` behind HTTPS. Do not deploy with open registration without an approved account policy and operational controls.

`POST /auth/register` and `POST /auth/login` accept `email` and `password` (registration also accepts `displayName`). Registration requires a password of at least 12 characters. Sessions use opaque random cookies; only session and CSRF token digests are stored in SQLite. Passwords are hashed with Argon2 via `pwdlib`. `GET /auth/me` resolves the user from the validated server-side session. `POST /auth/logout` requires the CSRF cookie to be echoed in the `X-CSRF-Token` header and revokes that session.

The session cookie is `HttpOnly`, `Secure` by default, `SameSite=Lax`, and path `/`. The CSRF cookie is readable by same-origin client code so it can be echoed in the header; it is not an authentication credential. Register/login require a same-origin `Origin` header. Session duration is controlled by `SESSION_TTL_SECONDS` (default eight hours). Password reset, email verification, rate limiting, account recovery, and session administration are not implemented. Portfolio endpoints remain unmounted. Review these limitations, use HTTPS, and add rate limiting before deployment.

## Model and rule boundaries

- IDs are UUID strings to match the existing frontend's string IDs.
- Instrument fields match `canonicalSymbol`, `symbol`, `displayName`, `exchange`, `isLargeCap`, and optional `sector`.
- Entry rows preserve sequence, date, reference entry price, stop-loss, RPS, RPT, capital snapshot, nullable whole-share quantity, sizing status, and notes. Non-positive RPS is allowed; the database does not derive or change trading formulas.
- A position has many entry rows and at most one shared position exit. Archive fields/status retain history.
- User records contain `password_hash`, never a plaintext password. Minimal register/login/logout/current-user endpoints and server-side sessions exist for local development; registration is disabled by default.
- Market-data snapshots, screening, pyramiding eligibility, entry sizing, and portfolio HTTP endpoints remain unimplemented.
- Duplicate/reopened-position policy, invalid-sizing persistence, and exit price basis remain unresolved as listed in `../docs/open-questions.md`.