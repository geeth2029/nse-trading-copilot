from dataclasses import dataclass
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")


@dataclass(frozen=True, slots=True)
class Settings:
    app_name: str = "NSE Trading Copilot API"
    database_url: str = "sqlite:///./data/nse_trading_copilot.db"
    registration_enabled: bool = False
    session_ttl_seconds: int = 28800
    session_cookie_name: str = "nse_session"
    csrf_cookie_name: str = "nse_csrf"
    session_cookie_secure: bool = True
    allow_unverified_market_data: bool = False
    market_data_provider: str = "upstox"
    upstox_api_base_url: str = "https://api.upstox.com"
    upstox_analytics_token: str | None = None
    upstox_request_timeout_seconds: float = 10.0
    upstox_quote_market_hours_ttl_seconds: int = 30
    upstox_quote_off_market_ttl_seconds: int = 3600
    upstox_weekly_candle_ttl_seconds: int = 86400
    upstox_instrument_master_ttl_seconds: int = 86400
    upstox_instrument_master_url: str = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
    large_cap_universe_path: str = "./data/universe/nse_largecap_current.json"
    tej_data_dir: str = "./data/market_data/tejhq"
    tej_status_url: str = "https://api.tejhq.dev/v1/status"
    tej_dataset_base_url: str = "https://huggingface.co/datasets/tejhq/indian-markets/resolve/main/prices_adjusted"
    tej_auto_sync: bool = True
    tej_request_timeout_seconds: float = 30.0
    tej_lookback_years: int = 2
    # ── Deployment / proxy settings ────────────────────────────────────────────
    # The exact HTTPS origin of the frontend (e.g. https://your-app.vercel.app).
    # Used in CORS headers and the same-origin / proxy-origin check.
    # For local development the default matches the Vite dev-server default.
    allowed_origin: str = "http://localhost:5173"
    # When the frontend is served at a different subdomain (Vercel preview URLs)
    # the backend only trusts the single exact origin above.  Do not set this to
    # a wildcard or a list — one explicit origin is the safe choice.

    @classmethod
    def from_environment(cls) -> "Settings":
        defaults = cls()
        return cls(
            app_name=os.getenv("APP_NAME", defaults.app_name),
            database_url=os.getenv("DATABASE_URL", defaults.database_url),
            registration_enabled=os.getenv("REGISTRATION_ENABLED", "false").lower() == "true",
            session_ttl_seconds=int(os.getenv("SESSION_TTL_SECONDS", str(defaults.session_ttl_seconds))),
            session_cookie_name=os.getenv("SESSION_COOKIE_NAME", defaults.session_cookie_name),
            csrf_cookie_name=os.getenv("CSRF_COOKIE_NAME", defaults.csrf_cookie_name),
            session_cookie_secure=os.getenv("SESSION_COOKIE_SECURE", "true").lower() == "true",
            allow_unverified_market_data=os.getenv("ALLOW_UNVERIFIED_MARKET_DATA", "false").lower() == "true",
            market_data_provider=os.getenv("MARKET_DATA_PROVIDER", defaults.market_data_provider).strip().lower(),
            upstox_api_base_url=os.getenv("UPSTOX_API_BASE_URL", defaults.upstox_api_base_url),
            upstox_analytics_token=os.getenv("UPSTOX_ANALYTICS_TOKEN") or None,
            upstox_request_timeout_seconds=float(os.getenv("UPSTOX_REQUEST_TIMEOUT_SECONDS", str(defaults.upstox_request_timeout_seconds))),
            upstox_quote_market_hours_ttl_seconds=int(os.getenv("UPSTOX_QUOTE_MARKET_HOURS_TTL_SECONDS", str(defaults.upstox_quote_market_hours_ttl_seconds))),
            upstox_quote_off_market_ttl_seconds=int(os.getenv("UPSTOX_QUOTE_OFF_MARKET_TTL_SECONDS", str(defaults.upstox_quote_off_market_ttl_seconds))),
            upstox_weekly_candle_ttl_seconds=int(os.getenv("UPSTOX_WEEKLY_CANDLE_TTL_SECONDS", str(defaults.upstox_weekly_candle_ttl_seconds))),
            upstox_instrument_master_ttl_seconds=int(os.getenv("UPSTOX_INSTRUMENT_MASTER_TTL_SECONDS", str(defaults.upstox_instrument_master_ttl_seconds))),
            upstox_instrument_master_url=os.getenv("UPSTOX_INSTRUMENT_MASTER_URL", defaults.upstox_instrument_master_url),
            large_cap_universe_path=os.getenv("LARGE_CAP_UNIVERSE_PATH", defaults.large_cap_universe_path),
            tej_data_dir=os.getenv("TEJ_DATA_DIR", defaults.tej_data_dir),
            tej_status_url=os.getenv("TEJ_STATUS_URL", defaults.tej_status_url),
            tej_dataset_base_url=os.getenv("TEJ_DATASET_BASE_URL", defaults.tej_dataset_base_url),
            tej_auto_sync=os.getenv("TEJ_AUTO_SYNC", "true").lower() == "true",
            tej_request_timeout_seconds=float(os.getenv("TEJ_REQUEST_TIMEOUT_SECONDS", str(defaults.tej_request_timeout_seconds))),
            tej_lookback_years=int(os.getenv("TEJ_LOOKBACK_YEARS", str(defaults.tej_lookback_years))),
            allowed_origin=os.getenv("ALLOWED_ORIGIN", defaults.allowed_origin).strip(),
        )
