# NSE Trading Copilot: Data-Source Research

**Research date:** 2026-10-24  
**Scope:** public provider documentation and terms reviewed for this planning task. No accounts were created, services purchased, API keys obtained, or endpoints called. The links below are primary-source links wherever available. Provider documentation establishes technical capability, not necessarily the right to redistribute data in a multi-user application.

## Executive findings

- Chartink officially supports web-based scans, weekly timeframes, indicators, and alert webhooks. The official material reviewed does **not** document a general API for fetching arbitrary scan results, OHLC history, or indicator values. A webhook is for scan-alert events, not a historical/data query API. Chartink's terms limit website content use to personal, non-commercial use and prohibit reproduction/distribution except the stated narrow personal-use allowance. An application integration and reuse of scan/data output therefore needs written permission; scraping or undocumented endpoints are not recommended.
- Upstox is the best technical fit for a local student prototype among the examined broker APIs: its official documentation provides NSE instrument files, market quote APIs, OHLCV candles, weekly candles, and documents weekly history from 2000 onwards in the V3 historical API. Its Analytics Token is documented as free, read-only, and valid for one year. This is **not** confirmation that one developer token can power a public/multi-user data service or that market data may be redistributed. That use must be confirmed with Upstox and applicable data terms before deployment.
- For official exchange data and public deployment, NSE Data & Analytics is the authoritative option, but market data/master data are paid products and governed by NSE's sharing/usage policy. NSE publishes real-time, delayed snapshot, historical EOD, and master-data product information. Exact subscription cost and downstream display/non-display rights depend on product and customer/use case; the reviewed pages link current tariffs but do not establish a low-cost student/API plan.
- The recognized Indian large-cap classification is the SEBI mutual-fund categorization framework: large cap means the top 100 companies by full market capitalization. AMFI's stock categorization/average-market-capitalization publication is the practical maintained list used for implementation; it is refreshed in half-year periods based on the six-month average market capitalization, with AMFI publishing the rank list. In this research session the current downloadable AMFI file URL, exact release calendar, and reuse license could not be verified from AMFI's current website. Confirm the actual latest file and permission before ingestion.
- For a student MVP, use a deterministic local fixture first. Then, if approved, use an Upstox-connected **single-user/local** adapter for quotes and candles, compute RSI and the 20-week SMA in the backend from provider OHLCV, and use a separately approved AMFI list. Do not make Chartink a runtime dependency. Before a hosted multi-user release, obtain written provider rights or use an NSE-authorized/licensed feed and review the required display/non-display distribution agreement.

## A. Chartink

### What official material establishes

1. **Product and data scope.** Chartink presents a browser-based scanner for NSE cash stocks and indices. Its scanner FAQ says a timeframe can be changed to Weekly/Monthly. It describes indicator filters and custom indicators; weekly RSI screening is therefore available as a user-created scan capability. Its terms page says site content includes the site's analysis tools and materials.
2. **Current/near-real-time claims.** The subscription page advertises real-time data for scans/charts and currently displays subscription tiers (₹780 monthly, ₹2,220 quarterly, ₹8,500 yearly, inclusive of taxes on the page at review). It also advertises scan refresh frequencies. Chartink's FAQ describes free data as delayed and premium chart/scan updates as every minute. Separately, Chartink's older “Near real-time updates” article describes a five-minute update cadence. These are product claims whose exact current plan behavior and NSE feed delay should be reconfirmed directly; a product update cadence is not the same as a guaranteed exchange timestamp or feed SLA.
3. **Candles and indicator timing.** The FAQ says scans can use weekly offsets. It also warns that scans run during a week can use incomplete weekly candles and can repaint until the weekly candle is complete. This is directly relevant: the Copilot's confirmed rule requires the most recently completed weekly candle, so the integration must explicitly exclude an in-progress weekly candle. Chartink's docs do not establish that an external consumer can reliably request precisely that completed-candle indicator value.
4. **Results/export.** Chartink's scanner is useful interactively, but its FAQ has historically said result-column customization is limited; a later FAQ response says additional columns are possible in Atlas dashboards. That is not a documented external machine-readable data API or a contract for reading every scan's RSI, SMA, price, and source timestamp. Do not assume an Excel/CSV export or a visible scan result can serve as a backend feed.
5. **Official integration method.** Chartink's FAQ describes webhooks for alerts: configured alerts send an HTTP POST with alert-related JSON to a user-supplied reachable URL. Alerts are a premium feature. This is an officially documented event mechanism, not evidence of a general endpoint to submit scans or query current/historical scan results. The available official docs reviewed do not document an API key/API contract for arbitrary scan retrieval.
6. **Terms.** Chartink's published Terms of Usage state that website content may not be reproduced, distributed, modified, displayed, or used except material downloaded into temporary storage on one device solely for personal, non-commercial use. The terms also state that user-created scans/charts/dashboards/content are licensed under GNU. These provisions do not clearly grant a separate app permission to automate retrieval, persist market-data payloads, or redistribute scan outputs to users. The GNU statement concerning user-created content should not be treated as a market-data redistribution license.

### Conclusion for this application

**No general official scan-data API was verified.** An alert webhook exists, but it does not satisfy the need for repeatable market snapshots, historical weekly OHLC, or values for all displayed results. Web scraping, reverse engineering, or undocumented endpoints are out of scope. Chartink may be used manually by a developer to compare scan behavior, but automated use in the app should remain blocked until Chartink provides written confirmation that a documented method and the intended storage/display/use are permitted. The terms' personal, non-commercial restriction makes this especially important even for a student project shared with others.

### Can Chartink supply each required field?

| Need | What official material supports | Research assessment |
|---|---|---|
| NSE symbols | Its scanner supports NSE cash stocks (not every NSE series; its FAQ says it excludes SME series). | Useful scan universe, not a confirmed complete authoritative NSE-listed-company master. |
| Company names | Scanner UI shows stocks; external master field/API contract not documented in the reviewed material. | Not verified as an app data feed. |
| Weekly RSI > 60 | Weekly timeframe and RSI/indicator filters are supported in the interactive scanner. | Technically plausible for a scan. RSI period/default and complete-candle behavior must be configured and verified; no supported external value-return contract found. |
| 20-week SMA | Weekly ranges and SMA/custom indicators are supported in scan/chart tools. | Technically plausible in UI, but not verified as an external feed. Must ensure calculation uses completed weekly candle only. |
| Reference price | Site footer says prices are sourced from NSE and are near-real-time unless indicated; scanner FAQ treats latest close as LTP. | A displayed reference quote exists, but this is not an API/redistribution authorization or an assured timestamp SLA. |
| Large-cap list | Chartink has a market-cap fundamental attribute, but that is not the AMFI/SEBI half-year category list. | Do not use an ad hoc market-cap threshold as a substitute for the confirmed classification framework. |

## B. Market-data provider comparison

“Documented” below means the capability is described in first-party documentation. It does not mean the provider has approved this app's cross-user data display or storage. “Not verified” is intentionally used where pricing, redistribution permission, or exact service guarantees were not established.

| Option | Fields and instruments | Historical weekly OHLC | Reference price freshness | API access, cost, restrictions | Authentication | Student / deployment fit |
|---|---|---|---|---|---|---|
| **Upstox Developer API** | Official instrument files/search provide instrument identifiers and instrument details; market quote endpoints document LTP, OHLC and fuller quote snapshots. Historical candles provide timestamp, O/H/L/C, volume and OI fields. The instrument file is broker instrument coverage, not necessarily the complete exchange listing universe. | **Yes.** Historical Candle V3 supports weekly (`weeks`, interval `1`) and docs state weekly history is available from Jan 2000 with no stated range limit. Confirm practical per-request limits and symbol coverage in adapter tests. | Quote APIs are presented as live market quote data. A freshness SLA and exact timestamp guarantee were not verified in the reviewed pages; persist provider/feed timestamps when present and measure actual lag. | Analytics Token is documented as **free**, read-only, valid one year, one per account, and supports quote/historical APIs. Standard API rate limits are documented. Terms permitting reuse/redistribution in a hosted app were **not verified**. Do not confuse the free API token with a data redistribution license. | Developer app/account. Analytics token generated in developer console; alternatively OAuth flow tied to the customer's Upstox login. Treat as a secret. | Strongest low-cost **local single-user prototype** option, subject to provider account and terms. Not approved yet for multi-user/public deployment; seek written confirmation or a per-user authorization/contract pattern. |
| **Zerodha Kite Connect** | NSE instrument master includes exchange symbol, company name (equities), instrument token, exchange and other fields. Quote APIs provide LTP, timestamp, last-trade time, OHLC, volume and depth. | The historical API documents candles as timestamp/OHLCV (optional OI) and intervals including day and intraday; it does not list a weekly interval. Weekly candles can be aggregated from daily bars, subject to data adjustments and the data-rights terms. | Quote snapshots expose exchange timestamp and last trade time; WebSocket supports streaming. Snapshot is request-time data, not an uptime/freshness SLA. | Pricing page currently lists Kite Connect at ₹500/month and Personal at free (verify current conditions before any use). Terms say live data cannot be displayed to the public at large, disallow scraping/database copies or cached copies for redistribution, and API use is restricted to authorized documented methods. This conflicts with a hosted multi-user screener unless explicitly approved. | Active Zerodha client account, developer app/API credentials, registered redirect, login/access-token flow. API secret stays server-side. | Good for a private user's own tool if terms and plan align; unsuitable as a shared app's common feed under the published public-display restriction. Historical weekly aggregation is possible technically, but not if it violates storage rights. |
| **Angel One SmartAPI** | Live Market Data API documents LTP, OHLC and Full modes; full mode lists feed/trade timestamps, volume, average price, circuit limits, 52-week range and depth. Instrument master/scrip token maps NSE symbols to token identifiers. | The documented historical intervals range from 1 minute through 1 day; no weekly interval is listed. Weekly candles can be assembled from daily records. Daily history is documented with a maximum 2,000 days in one request. | Full quote mode includes exchange feed and trade time; market quote API supports up to 50 tokens/request at 1 request/second according to docs. No end-to-end freshness SLA verified. | API pricing and market-data redistribution rights were not verified from official docs reviewed. Rate limits are documented per client code; obtain current terms before choosing it. | Angel One account, API key, login/JWT authorization and headers; documentation examples include client/network identifiers. | Technically capable for quotes and weekly aggregation, but more auth/request operational overhead; no clear advantage for this MVP. Not yet approved for shared deployment. |
| **NSE Data & Analytics (direct or authorized vendor)** | Official real-time products describe Capital Market quotes at several levels; paid EOD files include bhavcopy and security/trade details; paid Master Data is offered. Exact master schema should be checked in its specification. | Historical EOD data is offered; daily bars can be aggregated into weekly OHLC. The product page describes EOD binary files and historical data product. | Direct feeds include real-time levels; NSE also lists 1/5-minute snapshots and 15-minute delayed snapshots. Product-level timestamps and delivery SLA must be agreed in subscription. | Paid and contract-governed. NSE's Data Sharing & Usage Policy governs use, sharing, and distribution. Current tariff PDFs are linked (domestic/international; effective 1 April 2026), but no price is asserted here because product tier, customer type, and rights need sales confirmation. | Subscription/contract with NSE Data & Analytics or an authorized vendor; network/product delivery method depends on selected product. | Most defensible exchange-origin source for a public product if budget and display/non-display rights are approved. Likely excessive for an early student prototype. |
| **Chartink Premium / webhook** | UI exposes scan results; product claims NSE-sourced price and technical analysis, and weekly scan filters. Custom result columns vary by feature (scanner versus Atlas). | UI supports weekly scans/charts; an external OHLC history API was not found. | Product page advertises real-time scans/charts with premium updates; FAQ describes one-minute updates. Exact guarantee/current contractual feed delay needs direct confirmation. | Published subscription pricing as observed: ₹780/month, ₹2,220/quarter, ₹8,500/year. Official alert webhook exists; no general scan-query API verified. Published terms restrict website content to personal, non-commercial use and do not clearly authorize app redistribution. | Chartink account for premium scans/alerts; webhook configured by user and app endpoint publicly reachable. | Useful manual research tool. Not recommended as an automated backend source without written API/data-use approval. |

## C. Large-cap classification

### Framework

SEBI's mutual fund scheme categorization framework defines large-cap companies as the **1st to 100th company in terms of full market capitalization**. The following bands are mid-cap (101st–250th) and small-cap (251st onward). The Copilot should use the large-cap **membership list**, rather than independently inventing a rupee market-cap cutoff.

AMFI publishes the company categorization/average-market-capitalization list used in mutual fund classification implementation. The recognized process ranks listed companies using average full market capitalization over the preceding six-month period and AMFI issues updated lists on a half-year cycle. This provides effective-date snapshots suitable for the `LargeCapMembership` history already proposed in `architecture.md`.

### Source status and licensing

- SEBI's official circular is linked below. It establishes the category definition/framework.
- AMFI's official site exposes a Research & Information / Other Data section and terms of use, but the current list's direct downloadable URL and its underlying data-use conditions did not resolve reliably in this research session. Therefore the exact current file, publication dates, precise averaging window boundaries, and permission to persist/re-publish the classification list are **not verified** here.
- Treat AMFI as the preferred operational source, but before implementation identify the latest downloadable file, validate its source/published date and columns, record whether it is suitable for a public app, and confirm redistribution/caching rights from AMFI or the relevant source. If no reusable list is available, ask for written permission or select a licensed classification vendor. Do not derive category membership from a broker's universe, index constituents, Chartink's market-cap field, or an arbitrary cap threshold.
- Suggested maintenance: ingest each published half-year file, store the publication/effective date and raw-source reference, validate uniqueness/symbol mapping, and keep prior snapshots. Do not silently retain an old list if a refresh is missing; expose its as-of date and decide an approved stale-list policy.

## D. Recommendation

### First working version

1. Build and test against checked-in deterministic fixtures for NSE instrument records, weekly OHLC candles, quotes, and a dated large-cap membership snapshot. This permits the backend and frontend to be developed without live market dependencies or unapproved data reuse.
2. For a private, local student prototype only, use Upstox's documented read-only Analytics Token for quote and weekly candle retrieval **after the user confirms account/terms and Upstox confirms the intended use**. Use Upstox's instrument metadata only as a convenience; the approved NSE listing master remains the source of truth for the NSE-only universe.
3. Calculate 20-week SMA from the closing prices of the most recently completed weekly candles in the backend. Calculate weekly RSI in the backend too unless the product owner explicitly selects an approved provider's RSI definition. This avoids dependence on Chartink output-column behavior and makes the calculation reproducible. This is a source/implementation recommendation only; the fixed screening threshold and trade formulas remain unchanged.
4. Load the AMFI half-year classification file after confirming its current URL, schedule, symbol mapping, and reuse rights. Keep membership date-stamped and historical.
5. Label the quote as a reference price and store its source, provider timestamp/as-of timestamp, and retrieval time. Define and enforce a freshness threshold before live use.

This recommendation is not blanket approval to use Upstox data in a hosted multi-user app. Do not put one developer's secret token in a shared server or expose it to the browser. If each user must connect their own broker account, the account-linking experience, token storage, account eligibility, and provider terms need approval and security design.

### Fallback strategy

For implementation without an approved broker API, continue with deterministic fixtures and manually refreshed, explicitly licensed input files for development/testing only. For actual deployment, request quotes and historical data from NSE Data & Analytics or an NSE-authorized vendor with a written agreement covering the app's exact use, user count, derived indicators, display/non-display classification, caching, historical storage, and redistribution. A delayed NSE snapshot may be a lower-cost product tier, but its tariff and license must be checked; it is not assumed to be free or suitable for derived data display.

Chartink may remain a **manual scan validation tool** only. If Chartink later gives written authorization and a documented integration spec, it can be evaluated as an optional candidate generator, while the application's approved price/candle source remains authoritative for sizing and records.

## Known limitations and unresolved questions

- Technical provider API access does not by itself settle exchange data licensing, end-user display, derived data, retention, caching, or redistribution. Obtain written answers, particularly for a hosted/multi-user app.
- Upstox Analytics Token being free is verified from its docs; its account prerequisites, cross-user distribution permission, pricing changes, and contractual limits are not resolved. The token is not a free public market-data feed.
- Chartink's published terms and a webhook are verified; permission for this app's automated scanner ingestion is not. No general scan query API was found in the official materials checked.
- Official NSE subscription and tariff pages exist, but exact quote/history/master product price and use rights were not evaluated for a specific customer type. The tariff is product-specific; contact NSE Data & Analytics for a quote and license interpretation.
- AMFI's current downloadable classification source, exact upcoming publication date, and license terms remain unverified. The SEBI category definition is authoritative, but membership still needs the current AMFI list or an approved alternative.
- Broker instrument files may exclude securities or series that NSE lists, and Chartink itself documents some series exclusions. Confirm whether NSE SME, suspended, delisted, BE/BZ series, and newly listed stocks are in the desired universe. Do not widen or narrow the confirmed NSE-only requirement without product approval.
- Weekly RSI period and algorithm are unspecified. Price adjustment policy for splits, bonuses, rights, and other corporate actions is also not specified; provider candle adjustment semantics may differ. Resolve before comparing calculated indicators across sources.
- “Current” price freshness threshold and behavior outside market hours are product choices. A provider may return last traded price from a previous session; display the actual as-of time and return stale/unavailable per approved rules.
- RSI must be evaluated against the most recently completed week for coherent screening unless the owner explicitly approves a different temporal basis; the source's in-progress weekly candle can repaint.

## Decisions to confirm before implementation

1. Approve a private/local Upstox prototype as a temporary provider path, subject to reviewing Upstox's applicable terms and confirming data may be stored for this single-user purpose; or require fixture-only development until a licensed feed is selected.
2. For the multi-user deployment, choose a per-user broker connection model (each account connects its own provider account) or a centrally licensed data vendor/exchange subscription. Obtain written confirmation of usage rights; do not share one user's API credential.
3. Ask Chartink whether it provides any documented general scan-result API and whether API use, persistence, and display of its scanner/market data are permitted for this specific application. Until written confirmation, treat no such permission/API as available.
4. Approve AMFI as the operational large-cap list source after the latest download and terms are checked, or approve another licensed source. Confirm the half-year update policy, effective date, and what to do if a refresh is delayed.
5. Select source(s) for official NSE symbol/company master, weekly candles, RSI inputs, and reference prices. Confirm coverage for the full desired listed-stock universe and series.
6. Define quote freshness by market state, completed-week cutoff, corporate-action adjustment policy, RSI period/method, and stale/outage behavior. These choices do not change RSI > 60 or the existing SMA/entry/pyramiding formulas.
7. Confirm use rights for calculated/derived RSI and SMA values, downloaded snapshots, PDF reports, and cached historical values, including whether public display or redistribution is permitted.

## Primary sources

### Chartink

- [Chartink Terms of Usage](https://chartink.com/articles/terms-of-usage/)
- [Chartink Stock Screener FAQ](https://chartink.com/articles/scanner/stock-screener-faq/)
- [Chartink subscription and product features](https://chartink.com/subscription)
- [Chartink near-real-time update article](https://chartink.com/articles/scanner/near-real-time-updates/)
- [Chartink scanner pages](https://chartink.com/screeners)
- [Chartink alert webhook guide](https://chartink.com/articles/alerts/webhook-support-for-alerts/)
- [Chartink privacy policy](https://chartink.com/articles/privacy-policy/)

### Market data

- [Upstox API overview](https://upstox.com/developer/api-documentation/)
- [Upstox Historical Candle Data V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/)
- [Upstox Market Quote documentation](https://upstox.com/developer/api-documentation/market-quote/)
- [Upstox Analytics Token](https://upstox.com/developer/api-documentation/analytics-token/)
- [Upstox authentication](https://upstox.com/developer/api-documentation/authentication/)
- [Upstox instrument files/search](https://upstox.com/developer/api-documentation/instruments/)
- [Upstox API rate limits](https://upstox.com/developer/api-documentation/rate-limiting/)
- [Zerodha Kite Connect historical candles](https://kite.trade/docs/connect/v3/historical/)
- [Zerodha Kite quotes and instrument master](https://kite.trade/docs/connect/v3/market-quotes/)
- [Zerodha Kite Connect terms](https://kite.trade/terms/terms)
- [Zerodha API pricing](https://zerodha.com/pricing/#/api)
- [Angel One SmartAPI Historical API](https://smartapi.angelone.in/docs/Historical)
- [Angel One SmartAPI Live Market Data API](https://smartapi.angelone.in/docs/MarketData)
- [Angel One SmartAPI rate limits](https://smartapi.angelone.in/docs/RateLimit)
- [NSE paid real-time data](https://www.nseindia.com/market-data/real-time-data-subscription)
- [NSE paid EOD/historical data](https://www.nseindia.com/market-data/eod-historical-data-subscription)
- [NSE paid master data](https://www.nseindia.com/market-data/paid-master-data)
- [NSE data sharing and usage policy](https://www.nseindia.com/market-data/nse-data-policy)
- [NSE products tariff](https://www.nseindia.com/static/market-data/products-tariff)

### Large-cap classification

- [SEBI circular: Categorization and Rationalization of Mutual Fund Schemes (6 October 2017)](https://www.sebi.gov.in/legal/circulars/oct-2017/categorization-and-rationalization-of-mutual-fund-schemes_36199.html)
- [AMFI Research & Information](https://www.amfiindia.com/research-information)
- [AMFI Other Data](https://www.amfiindia.com/research-information/other-data)
- [AMFI Terms of Use](https://www.amfiindia.com/terms-of-use)