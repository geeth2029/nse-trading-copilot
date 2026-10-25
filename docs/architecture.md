# NSE Trading Copilot: Architecture Proposal

## Scope and principles

The application screens NSE-listed stocks, calculates reference trade parameters, evaluates pyramiding conditions, and stores user-specific portfolio history. It is an assistance and record-keeping tool only: it must not submit, amend, or cancel broker orders. A displayed reference market price is not represented as an executed trade price.

The first release should be a modular monolith: a React/TypeScript client and a Python/FastAPI API backed by SQLAlchemy and SQLite for local development. Keep market data, calculations, and persistence behind interfaces so later approved providers or a production database do not require changing trading rules. Use Pydantic request/response schemas and explicit service-layer validation. Use decimal arithmetic for money and prices; quantities are whole shares.

## Proposed directory structure

```text
docs/
  architecture.md
  implementation-plan.md
  open-questions.md
backend/
  pyproject.toml
  alembic.ini
  alembic/
    versions/
  app/
    main.py
    core/                 # settings, errors, auth/security dependencies
    api/v1/                # routers and API dependencies
    models/                # SQLAlchemy entities
    schemas/               # Pydantic request/response types
    repositories/          # scoped persistence queries
    services/              # calculations, screening, portfolio, reports
    market_data/           # provider protocol, adapters, normalization
  tests/
    unit/
    integration/
    api/
frontend/
  package.json
  src/
    app/                   # routes, providers, application shell
    features/
      auth/
      screener/
      portfolio/
      reports/
    components/
    api/                   # typed API client
    types/
  tests/
    unit/
    e2e/
```

Use SQLAlchemy migrations (Alembic) rather than relying on implicit table creation once schema evolution begins. Keep secrets and environment-specific configuration out of source control. Git is used from the initial scaffold, with generated artifacts and local databases excluded.

## Responsibilities and boundaries

### Frontend

- React, TypeScript, and Tailwind CSS UI for sign-in, screening, stock detail, entry capture, portfolio history, eligibility, exit capture, and PDF download.
- Render server-supplied calculation statuses and market-data timestamps. The UI may provide immediate field feedback but must not be the authority for trading calculations or authorization.
- Clearly label every current market price as a reference price, with its source and as-of time. Separately label manually recorded entry and exit values according to the approved recording workflow.
- Show invalid stop-loss warnings without implying that a valid quantity exists. Show eligibility independently from whether sizing can be calculated.
- Use a typed API client and map structured API errors to field-level or page-level messages.

### Backend

- FastAPI owns authentication, authorization, request validation, market-data normalization, calculations, portfolio lifecycle, PDF generation, and persistence.
- Routers stay thin. Services enforce business rules; repositories require an authenticated owner scope on all user-owned reads and writes.
- A market-data provider protocol isolates ingestion from Chartink or any future approved provider. Store normalized source and timestamps rather than allowing provider-specific response shapes into the domain model.
- ReportLab generates PDFs from authorized, persisted portfolio data. A PDF request must be scoped to the requesting user and stock position.

## Domain entities and relationships

Names are illustrative; the implementation may choose equivalent names.

| Entity | Purpose and important fields |
|---|---|
| `User` | `id`, normalized unique email/username, password hash, created timestamp, account status. Never store plaintext passwords. |
| `Instrument` | NSE-only stock master: canonical symbol, display name, exchange fixed to NSE, active/listing state. Enforce a unique canonical symbol within the supported exchange. |
| `LargeCapMembership` | Instrument, classification framework/source, effective date range, source publication/as-of date, ingestion timestamp, membership flag. Preserve source history for reproducible screening. |
| `MarketSnapshot` | Instrument, provider/source, reference price and its as-of timestamp, latest completed weekly candle date, 20-week SMA, weekly RSI, retrieval timestamp, and data-quality/freshness metadata. Store nullable indicators when source data cannot provide them; do not fabricate values. |
| `PortfolioPosition` | User-owned position for one instrument, created timestamp, lifecycle status, archive timestamp/reason, and optional exit relationship. Keep historical positions rather than deleting them. A user may have multiple historical positions for one instrument only if the approved reopen policy permits it. |
| `TradeEntry` | Position, sequence/created timestamp, entry date, reference entry price, recorded stop-loss, RPS, RPT, integer quantity (nullable only if the invalid-sizing save behavior is approved), sizing status, capital snapshot, and market snapshot reference. Entry price and stop-loss are immutable after creation. Each pyramid adds a row; do not overwrite the prior entry. |
| `PositionExit` | One exit for the entire accumulated position: position (unique), exit price, exit date, recorded timestamp, and price basis/source. Individual entry P&L is derived by applying this exit to each entry quantity. |

### Relationships, constraints, and immutability

- `User 1:N PortfolioPosition`; `Instrument 1:N PortfolioPosition`; `PortfolioPosition 1:N TradeEntry`; `PortfolioPosition 0:1 PositionExit`.
- Every user-owned record is reachable through an owner-scoped position. Query and mutation paths must include the authenticated user ID. Add database foreign keys and uniqueness constraints where supported; do not accept `user_id` as authority from a client request.
- Record each entry as a snapshot. Do not recompute historical RPS, RPT, quantity, entry price, or recorded stop-loss when capital, quotes, or indicators change. Do not expose a general update endpoint for immutable entry fields.
- The position-level exit is the source of truth for the one-exit-per-accumulated-position rule. The stock report can present its exit price/date alongside each entry as a joined view, satisfying entry-wise display without duplicating mutable exit data on every entry.
- Preserve entries, exits, and snapshots when archiving. Use lifecycle/status transitions and timestamps; do not cascade-delete trading history when a user archives a stock.
- Use `Decimal`/database numeric types with an agreed precision and explicit quantization policy. The quantity is an integer. Define uniqueness and check constraints for valid values, but do not impose a positive-RPS constraint that would prevent a warning/invalid-sizing record if that workflow is approved.

## Trading calculation service

Implement pure, deterministic functions with typed inputs and explicit result statuses. Do not duplicate formulas in React.

### Initial and pyramid entry sizing

For an entry, take user-entered capital, the current reference share price, and the 20-week SMA from the most recently completed weekly candle:

```text
RPT = User Capital * 0.01
Entry Price = Current Reference Share Price
Stop-Loss = 20-week SMA from the most recently completed weekly candle
RPS = Entry Price - Stop-Loss
Quantity = floor(RPT / RPS), only when RPS > 0
```

Require positive capital and valid positive market values before calculating. If the stop-loss is greater than or equal to entry price, return a warning and an explicit unavailable quantity/RPS sizing status as appropriate. Never divide by zero, return a negative quantity, or label an invalid sizing result as valid. The user may continue past the warning, but whether that means saving an entry with `quantity = null` or only continuing to view/record it without a sized entry is an open product decision. Do not silently substitute zero shares.

Keep the reference entry price distinct from an actual execution price. The app does not place orders; it must not claim that the reference price was filled. Capture data source and quote timestamp alongside the calculation inputs so the result is explainable later.

### Pyramiding eligibility

Evaluate eligibility against the latest completed weekly market snapshot and the entry price in the most recent entry row for the active position:

```text
Weekly RSI > 60
Previous Entry Price <= Current 20-week SMA <= Previous Entry Price + 3
```

Both conditions are required. The RSI comparison is strictly greater than 60; the SMA bounds are inclusive; `3` is in the same price units as the entry price. Return `Eligible` only when both checks are true, otherwise `Not Eligible`, with the component values and timestamps used. Missing or stale required inputs should be represented as unavailable, not interpreted as passing. The UI displays the result; whether the action is disabled is not assumed. If a new entry is created, calculate its RPT and sizing from the user's entered capital and current reference share price using the same initial-entry formulas, and snapshot the new stop-loss.

Eligibility and sizing are distinct: passing the two eligibility checks does not make an invalid RPS valid.

### Exits and P&L

Allow one recorded exit for the entire position. For each entry with a valid quantity:

```text
Entry P&L = (Exit Price - Entry Price) * Entry Quantity
Consolidated P&L = sum of individual entry P&L values
Accumulated quantity = sum of individual entry quantities
```

Do not include transaction costs. If an entry has unavailable quantity, the report must label its P&L unavailable and must not silently treat it as zero; the consolidated P&L representation for mixed/unknown quantities needs the product decision recorded in `open-questions.md`. Validate that an exit cannot be recorded twice and that exit price/date are supplied under the approved recording rules.

## Market-data integration strategy

Market-data integration is a release gate, not an assumption. First verify whether Chartink offers an officially supported integration method for this use case and whether its terms permit the intended automated retrieval, storage, and display. Do not assume a public API exists; do not scrape private endpoints, bypass controls, or rely on an undocumented interface. Record the reviewed method, terms, constraints, and approval before implementing an adapter.

If no supported, permitted Chartink integration is available, stop at a provider decision: present viable alternatives for explicit approval rather than silently switching data sources. Screening requires enough data to establish NSE listing, weekly RSI, large-cap membership, and the completed-candle SMA. The current reference share price also needs a source. Confirm whether Chartink supplies all required fields or whether separately approved sources are needed, and align timestamps and calculation definitions.

The provider boundary should normalize symbol, exchange, reference price, weekly RSI, completed weekly candle date, 20-week SMA, source, source as-of time, retrieval time, and quality/freshness status. Keep raw provider payloads only where permitted and necessary; define retention after reviewing provider terms. Mark stale or partial data visibly and return an unavailable state rather than silently reusing it. The acceptable freshness threshold, market-hours behavior, and outage policy are unresolved. Scanner output is a candidate list; backend checks must enforce NSE-only scope and apply the approved large-cap membership data.

## Authentication and authorization

- Require authentication for all personal portfolio and report endpoints.
- For an initial first-party web app, use server-validated sessions in `Secure`, `HttpOnly`, appropriately `SameSite` cookies, plus CSRF protection for state-changing requests. Hash passwords with a modern adaptive password hash (for example Argon2id) and rate-limit authentication attempts. Avoid storing bearer tokens in browser local storage.
- Derive the owner identity from the authenticated server-side principal. Apply owner scoping in service/repository queries for positions, entries, exits, and PDFs; return a non-disclosing not-found response for another user's IDs.
- Enforce authorization on every object access, including nested entry/exit resources and PDF generation. Add tests proving one user's IDs cannot read, update, archive, close, or export another user's records.
- Define registration, email verification, password recovery, session expiry/revocation, and account deletion/retention policies before launch; these are not specified yet.

## API proposal

Use versioned JSON endpoints under `/api/v1`. Exact schemas and pagination semantics are implementation-phase decisions.

| Method and path | Responsibility |
|---|---|
| `POST /auth/register` | Create account, if open registration is approved. |
| `POST /auth/login` | Authenticate and establish session. |
| `POST /auth/logout` | Revoke current session. |
| `GET /auth/me` | Return authenticated account summary. |
| `GET /screening/stocks` | Return the latest qualifying NSE and approved large-cap candidates with market-data timestamps and data status. |
| `GET /stocks/{symbol}` | Return stock detail and latest usable market snapshot. |
| `GET /stocks/{symbol}/pyramid-eligibility` | Evaluate latest position's most recent entry against RSI and SMA conditions; return unavailable when required data is missing/stale. |
| `GET /portfolio/positions` | List the user's active positions; allow explicit filters for completed/archived history. |
| `POST /portfolio/positions` | Start a tracked position for an instrument, subject to duplicate-active-position policy. |
| `GET /portfolio/positions/{position_id}` | Return a user-scoped position, entries, accumulated quantity, exit, and P&L statuses. |
| `POST /portfolio/positions/{position_id}/entries` | Create an initial or pyramid entry from submitted capital and a server-selected/validated market snapshot; preserve its calculation snapshot. |
| `POST /portfolio/positions/{position_id}/exit` | Record the single exit for the accumulated position. |
| `POST /portfolio/positions/{position_id}/archive` | Soft-archive a position without deleting history. |
| `GET /portfolio/positions/{position_id}/report.pdf` | Generate/download an owner-scoped individual-stock PDF. |

Do not let the client submit authoritative SMA, RSI, eligibility, quantity, or user ownership values. If the client selects a displayed snapshot, validate it server-side and reject snapshots that violate the chosen freshness policy. Use idempotency protection for entry/exit creation if retries could otherwise create duplicate records; the exact mechanism is an implementation detail to settle during API design.

## Validation and error handling

- Pydantic validates request shape and types; domain services validate business constraints and calculations; database constraints provide a final integrity layer.
- Reject non-NSE instruments, unknown symbols, malformed dates, non-finite values, non-positive capital, and invalid exit/entry inputs as appropriate. A market-data absence/staleness is a structured domain result, not a fabricated number.
- Return a consistent error envelope with a stable code, safe user-facing message, optional field errors, and request/correlation ID. Do not expose stack traces, SQL details, provider credentials, or cross-user record existence.
- Distinguish validation failures, authentication/authorization failures, conflicts (such as a second exit), provider unavailability, stale data, and internal errors. Log operational details server-side with sensitive fields redacted.
- The warning path for `Stop-Loss >= Entry Price` must be explicit, require user acknowledgement if that is the approved behavior, and preserve an invalid/unavailable sizing status. Acknowledgement is not permission to create a negative or zero-risk-derived quantity.

## Testing strategy

- **Calculation unit tests:** exact 1% RPT, floor behavior, positive/zero/negative RPS, strict RSI boundary at 60, inclusive SMA bounds, upper/lower bound failures, missing indicators, and pyramiding eligibility independent from sizing.
- **Domain tests:** immutable entry snapshots after capital/market data changes; latest entry selection; accumulated quantity; one exit only; per-entry and consolidated P&L; archive retains history; invalid-size reporting behavior.
- **API/integration tests:** authentication, owner scoping for every resource/action/export, request validation, database constraints, session/CSRF behavior, provider errors/staleness, and PDF response content type and ownership.
- **Frontend tests:** accessible rendering for eligible/not eligible/unavailable states, warning acknowledgement flow, distinction between reference and execution/recorded prices, portfolio lifecycle views, API error states, and report download. Use component tests plus a small end-to-end suite for sign-in through record/exit/archive flows.
- **Provider contract tests:** fixtures for normalization, NSE-only filtering, weekly candle completeness, source timestamps, and provider outages. Never make deterministic unit tests depend on live markets.
- Use a temporary SQLite database for local/API tests and deterministic fake provider data. Add migration tests as schema evolves.

## Security, privacy, and operational safeguards

- No broker-order placement, broker credentials, or order-submission API in scope. Keep that boundary in architecture and tests.
- Protect user data with authentication, object-level authorization, secure cookies/CSRF controls, password hashing, rate limiting, input validation, and redacted logs. Use HTTPS in deployment and managed secret injection.
- Treat market data as third-party licensed data: validate use, storage, display, attribution, rate limits, retention, and redistribution rights before integration.
- Minimize personal data. Define backup, retention, account deletion, and incident response policy. PDF exports contain personal financial records and require the same authorization and careful handling as API data.
- SQLite is the initial development database. For a multi-user production deployment with concurrent writes, backups, and operational availability, plan a migration to PostgreSQL before public launch unless workload and deployment constraints demonstrate SQLite is sufficient. The SQLAlchemy/repository boundary should keep this migration tractable; the choice is a deployment gate, not an implicit production assumption.
- Pin and audit dependencies, run static/type checks and tests in CI, protect secrets, apply migrations deliberately, and monitor provider freshness/errors without logging sensitive portfolio payloads.

## Deployment outline

During development, run the Vite-based frontend and FastAPI locally against SQLite and fake/approved sandbox market snapshots. CI should install locked dependencies, run frontend and backend checks, migration tests, and build artifacts. For a controlled production deployment, serve the frontend as static assets behind HTTPS and run the API as a separate service with a persistent managed database, backups, migrations, health checks, and secret management. Use PostgreSQL for a multi-user production service unless a documented operational assessment approves SQLite. Configure CORS narrowly if frontend and API origins differ, enforce secure cookie settings, and avoid logging personal trading records. Select hosting, market-data egress, retention, and recovery targets after the open decisions are resolved.