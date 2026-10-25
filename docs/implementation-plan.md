# Implementation Plan

This plan is intentionally staged. No application code, packages, or external services are introduced during planning. Phase exit criteria involving Chartink, classification, or recording behavior are decision gates: implementation should not guess past them.

## Phase 0: Resolve product and data gates

1. Verify an officially supported Chartink integration method and its permitted usage for retrieval, storage, and display. Document evidence and restrictions. If unavailable or not permitted, obtain approval for an alternative before building the adapter.
2. Select the authoritative large-cap framework/source (candidate: the current AMFI/SEBI-aligned large-cap classification list), confirm the stock universe and update cadence, and define historical membership handling.
3. Decide market-data sources and definitions for current reference price, weekly RSI, and 20-week SMA; define completed-week candle selection, freshness threshold, outage behavior, and timestamps shown to users.
4. Approve warning acknowledgement and persistence behavior when stop-loss is at/above entry, including quantity and P&L treatment for unavailable sizing.
5. Decide capital snapshot semantics, entry/exit date and price capture, duplicate/reopen policy, and active/completed/archived lifecycle.

**Exit criterion:** the decisions listed in `open-questions.md` that affect schema or calculations have owners and approved answers. Do not implement live market integration before the data rights gate passes.

## Phase 1: Scaffold and contracts

1. Create the Git repository structure from `architecture.md`, Python FastAPI service, React/TypeScript/Tailwind client, formatting/type-checking/test configuration, and environment templates without real secrets.
2. Define API error, authentication, market snapshot, calculation result, position, entry, exit, and report contracts.
3. Add SQLAlchemy models and first migration for users, NSE instruments, classification snapshots, market snapshots, positions, entries, exits, and sessions as finalized by the decision gates.
4. Establish CI for backend lint/type/test checks, frontend lint/type/test/build checks, and migration verification.

**Depends on:** Phase 0 schema and API decisions. **Exit criterion:** clean local startup with a fake provider and migration from an empty database.

## Phase 2: Calculation and market-data foundation

1. Implement pure trading calculation functions using decimal arithmetic and explicit available/unavailable/warning statuses.
2. Add tests for formulas, strict/inclusive boundaries, invalid RPS, rounding, and missing/stale data before connecting a real provider.
3. Implement the normalized provider protocol and deterministic fake provider.
4. Once approved, implement the supported Chartink adapter and any separately approved data adapters; add contract tests, rate/error handling, and source timestamp/freshness metadata.
5. Implement NSE instrument validation and large-cap membership ingestion/versioning using the approved source and schedule.

**Depends on:** Phase 0 provider, source, and freshness decisions. **Exit criterion:** reproducible scanner candidates and calculations from timestamped fixtures; no undocumented or unlicensed scraping.

## Phase 3: Identity and user-scoped portfolio core

1. Implement account/session flows and server-side principal dependencies.
2. Apply owner-scoped repository/service access consistently and test cross-user denial before exposing portfolio endpoints.
3. Implement position creation, immutable entry snapshots, initial sizing, pyramiding entry creation, and accumulated quantity.
4. Implement eligibility evaluation using the most recent entry row and latest usable completed weekly snapshot; keep the eligibility result separate from sizing status.
5. Implement archive/status transitions and preserve all underlying records.

**Depends on:** Phase 1 schema and Phase 2 calculation/provider contracts. **Exit criterion:** authenticated users can manage only their own positions; history and entry snapshots remain unchanged as market data/capital inputs change.

## Phase 4: Exits, P&L, and reports

1. Implement one position-level exit with conflict protection and the approved exit price/date basis.
2. Calculate per-entry P&L and consolidated P&L from the stored entry snapshots and one shared exit; show unavailable totals honestly when an entry's quantity is unavailable.
3. Generate individual-stock PDFs with source timestamps, entry snapshots, exit, quantity, and P&L; enforce owner authorization on every report request.
4. Add regression tests for repeated exit, archive retention, mixed calculation availability, and report contents.

**Depends on:** Phase 3 and approved invalid-quantity/P&L semantics. **Exit criterion:** exit and report workflows are consistent with persisted records and contain no transaction-cost deductions.

## Phase 5: User interface and end-to-end workflows

1. Build sign-in and a responsive screening view with qualifying NSE/large-cap stocks, data freshness, and the “Let's Dive In” action.
2. Build stock detail and initial-entry flow, including explicit reference-price labels, calculation values, and stop-loss warning/acknowledgement.
3. Build portfolio position view with entries, accumulated quantity, eligibility result, archive/completed history, and one exit action.
4. Add per-stock PDF download and accessible loading, empty, stale-data, unavailable, validation, and provider-error states.
5. Cover critical flows with browser-level tests using deterministic data.

**Depends on:** stable API contracts from Phases 2–4. **Exit criterion:** a user can complete an end-to-end paper-tracking workflow without any broker order capability or ambiguity about reference versus recorded prices.

## Phase 6: Hardening and deployment readiness

1. Review authorization, CSRF, session expiry, rate limits, secret handling, dependency vulnerabilities, and logging redaction.
2. Verify backups/restore, migrations, monitoring, provider-freshness alerting, and deployment configuration.
3. Decide and execute SQLite-to-PostgreSQL migration for multi-user production unless a documented deployment assessment approves SQLite.
4. Run a release checklist covering data-provider permissions, classification source freshness, calculation boundaries, PDF access control, and no-order-placement assurance.

**Depends on:** all feature phases and deployment/data policy decisions. **Exit criterion:** operational and legal/data gates are approved; production behavior is tested against a documented release checklist.

## Dependency summary

```text
Phase 0 decisions
  -> Phase 1 contracts/schema
  -> Phase 2 calculation + market data
  -> Phase 3 identity + portfolio
  -> Phase 4 exits + reports
  -> Phase 5 integrated UI
  -> Phase 6 hardening + deployment
```

Frontend shell work can begin after Phase 1 contracts, but live screening and end-to-end workflows depend on approved data integration and finalized portfolio semantics. No phase should weaken the specified formulas or pyramiding comparisons.