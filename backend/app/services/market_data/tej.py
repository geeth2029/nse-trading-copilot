"""TejHQ market data provider implementation using Hugging Face Parquet mirror.

Provides 100% free, end-of-day (EOD) market data for NSE cash equity instruments
without requiring Demat accounts, broker credentials, or paid subscriptions.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
import json
import logging
from pathlib import Path
import shutil
import tempfile
import threading
from typing import Any

import httpx
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from app.core.config import Settings
from app.services.market_data.base import (
    MarketDataProvider,
    MarketQuote,
    WeeklyCandle,
)
from app.services.market_data.calendar import (
    IST,
    NSE_MARKET_CLOSE_TIME,
    NSETradingCalendar,
)
from app.services.market_data.errors import (
    InstrumentNotFoundError,
    MarketDataUnavailableError,
    StaleDataError,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class DailyEquityRecord:
    """Represents a single session EOD equity record from TejHQ adjusted dataset."""

    date: date
    symbol: str
    series: str
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal  # Raw unadjusted close
    volume: int
    adj_factor_cumulative: Decimal
    adj_close: Decimal  # Back-adjusted close
    isin: str | None


class DailyToWeeklyCandleAggregator:
    """Aggregates daily EOD records into completed and forming ISO weekly candles.

    Strict rules:
    - Weekly open is the adjusted open of the first trading day of the calendar week.
    - Weekly high is the maximum adjusted high across all trading days in the week.
    - Weekly low is the minimum adjusted low across all trading days in the week.
    - Weekly close is the adjusted close of the final trading day of the week.
    - Weekly volume is the sum of volumes across all trading days in the week.
    - Weekly completion status is determined strictly by the NSE trading calendar.
    - Incomplete weeks are marked is_completed=False and never treated as completed.
    """

    def __init__(self, calendar: NSETradingCalendar) -> None:
        self._calendar = calendar

    def aggregate(
        self,
        records: list[DailyEquityRecord],
        symbol: str,
        as_of: datetime,
    ) -> list[WeeklyCandle]:
        """Aggregate sorted daily records into WeeklyCandle objects."""
        if not records:
            return []

        # Filter strictly for EQ (Equity cash) series
        eq_records = [r for r in records if r.series == "EQ"]
        if not eq_records:
            eq_records = records

        # Group by calendar week (Monday as week key)
        weeks: dict[date, list[DailyEquityRecord]] = {}
        for r in eq_records:
            monday = r.date - timedelta(days=r.date.weekday())
            if monday not in weeks:
                weeks[monday] = []
            weeks[monday].append(r)

        weekly_candles: list[WeeklyCandle] = []
        for monday in sorted(weeks.keys()):
            days = sorted(weeks[monday], key=lambda x: x.date)
            first_day = days[0]
            last_day = days[-1]

            # Adjust historical OHLC using cumulative adjustment factor
            adj_open = (first_day.open * first_day.adj_factor_cumulative).quantize(Decimal("0.0001"))
            adj_high = max(d.high * d.adj_factor_cumulative for d in days).quantize(Decimal("0.0001"))
            adj_low = min(d.low * d.adj_factor_cumulative for d in days).quantize(Decimal("0.0001"))
            adj_close = (last_day.close * last_day.adj_factor_cumulative).quantize(Decimal("0.0001"))
            total_volume = sum(d.volume for d in days)

            # Candle date is the actual session date of the week's last trading day
            candle_date = last_day.date
            is_completed = self._calendar.is_week_completed(candle_date, now=as_of)

            weekly_candles.append(
                WeeklyCandle(
                    symbol=symbol,
                    candle_date=candle_date,
                    open_price=adj_open,
                    high_price=adj_high,
                    low_price=adj_low,
                    close_price=adj_close,
                    volume=total_volume,
                    is_completed=is_completed,
                )
            )

        return weekly_candles


class TejMarketDataProvider(MarketDataProvider):
    """MarketDataProvider implementation backed by TejHQ's MIT-licensed EOD dataset.

    Features:
    - Zero Demat, broker account, or API key requirement.
    - Reads local Parquet partitions (`prices_adjusted_nse_{year}.parquet`) via PyArrow.
    - Atomic partition download and cached metadata validation.
    - Historical indicator calculation using corporate action back-adjusted prices.
    - True separation of raw unadjusted latest EOD closing price from adjusted history.
    - Automated calendar-aware freshness check with weekend tolerance.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        data_dir: Path | str | None = None,
        calendar: NSETradingCalendar | None = None,
        client: httpx.AsyncClient | None = None,
        clock: Callable[[], datetime] | None = None,
        auto_sync: bool | None = None,
    ) -> None:
        self._settings = settings or Settings.from_environment()
        self._data_dir = Path(data_dir or self._settings.tej_data_dir).resolve()
        self._calendar = calendar or NSETradingCalendar()
        self._client = client
        self._clock = clock
        self._auto_sync = (
            auto_sync if auto_sync is not None else self._settings.tej_auto_sync
        )
        self._aggregator = DailyToWeeklyCandleAggregator(self._calendar)
        self._status_url = self._settings.tej_status_url
        self._dataset_base_url = self._settings.tej_dataset_base_url
        self._timeout_seconds = self._settings.tej_request_timeout_seconds
        self._lookback_years = max(1, self._settings.tej_lookback_years)

        # Ensure cache directory exists
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._isin_index: dict[str, str] | None = None
        self._index_lock = threading.Lock()

    def _get_now(self) -> datetime:
        """Resolve current UTC timestamp using injected clock or system time."""
        if self._clock is not None:
            return self._clock()
        return datetime.now(timezone.utc)

    def _get_required_years(self, now_utc: datetime) -> list[int]:
        """Determine calendar years required to satisfy lookback requirements."""
        current_year = now_utc.year
        return [current_year - i for i in reversed(range(self._lookback_years))]

    def get_partition_path(self, year: int) -> Path:
        """Return the local filesystem path for an annual Parquet partition."""
        return self._data_dir / f"prices_adjusted_nse_{year}.parquet"

    async def get_latest_upstream_trading_date(self) -> date | None:
        """Check TejHQ public status endpoint for the latest available trading date."""
        try:
            if self._client is not None:
                resp = await self._client.get(
                    self._status_url, timeout=self._timeout_seconds
                )
            else:
                async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                    resp = await client.get(self._status_url)

            if resp.status_code == 200:
                payload = resp.json()
                date_str = payload.get("trading_date")
                if date_str:
                    return date.fromisoformat(date_str)
        except Exception as exc:
            logger.warning("Failed to query TejHQ status endpoint: %s", exc)
        return None

    async def sync_partitions_if_needed(self, now_utc: datetime | None = None) -> None:
        """Atomically download or refresh required annual partitions from Hugging Face."""
        if not self._auto_sync:
            return

        now = now_utc or self._get_now()
        required_years = self._get_required_years(now)
        latest_completed_day = self._calendar.get_latest_completed_trading_day(now)

        for year in required_years:
            target_path = self.get_partition_path(year)
            needs_download = False

            if not target_path.exists():
                needs_download = True
            elif year == now.year:
                # Check if current year's file contains the latest completed trading day
                try:
                    max_date = self._get_max_date_in_partition(target_path)
                    if max_date is None or max_date < latest_completed_day:
                        # Check upstream status: if upstream has not published a date newer than our cache, skip redundant download
                        upstream_date = await self.get_latest_upstream_trading_date()
                        if upstream_date is not None and max_date is not None and max_date >= upstream_date:
                            needs_download = False
                        else:
                            needs_download = True
                except Exception:
                    needs_download = True

            if needs_download:
                download_url = f"{self._dataset_base_url}/nse_{year}.parquet"
                await self._download_partition_atomic(download_url, target_path)

    async def _download_partition_atomic(self, url: str, target_path: Path) -> None:
        """Download remote Parquet file to temporary path and atomically replace target."""
        temp_file = target_path.with_suffix(".parquet.tmp")
        logger.info("Downloading TejHQ partition from %s to %s", url, target_path)

        try:
            if self._client is not None:
                resp = await self._client.get(
                    url, timeout=self._timeout_seconds, follow_redirects=True
                )
                if resp.status_code != 200:
                    raise MarketDataUnavailableError(
                        f"Failed to download TejHQ partition {url}: HTTP {resp.status_code}"
                    )
                temp_file.write_bytes(resp.content)
            else:
                async with httpx.AsyncClient(
                    timeout=self._timeout_seconds, follow_redirects=True
                ) as client:
                    async with client.stream("GET", url) as stream_resp:
                        if stream_resp.status_code != 200:
                            raise MarketDataUnavailableError(
                                f"Failed to download TejHQ partition {url}: HTTP {stream_resp.status_code}"
                            )
                        with open(temp_file, "wb") as f:
                            async for chunk in stream_resp.aiter_bytes(chunk_size=65536):
                                f.write(chunk)

            # Validate the downloaded parquet file is not corrupt
            pq.read_schema(temp_file)

            # Atomic replace
            temp_file.replace(target_path)
            logger.info("Successfully installed partition %s", target_path.name)
        except Exception as exc:
            if temp_file.exists():
                temp_file.unlink(missing_ok=True)
            logger.error("Error downloading partition %s: %s", target_path.name, exc)
            raise MarketDataUnavailableError(
                f"Failed to synchronize market data partition {target_path.name}: {exc}"
            ) from exc

    def _get_max_date_in_partition(self, partition_path: Path) -> date | None:
        """Read the maximum trading date present in a Parquet partition."""
        if not partition_path.exists():
            return None
        table = pq.read_table(partition_path, columns=["date"])
        if table.num_rows == 0:
            return None
        date_array = table["date"]
        max_d = pc.max(date_array).as_py()
        if isinstance(max_d, date):
            return max_d
        elif isinstance(max_d, str):
            return date.fromisoformat(max_d)
        return None

    def _load_daily_records_for_symbols(
        self,
        symbols: list[str],
        now_utc: datetime,
    ) -> dict[str, list[DailyEquityRecord]]:
        """Read and parse daily records for given symbols across cached partitions."""
        required_years = self._get_required_years(now_utc)
        results: dict[str, list[DailyEquityRecord]] = {s: [] for s in symbols}
        symbols_set = set(symbols)

        columns = [
            "date",
            "symbol",
            "series",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "adj_factor_cumulative",
            "adj_close",
            "isin",
        ]

        for year in required_years:
            path = self.get_partition_path(year)
            if not path.exists():
                continue

            try:
                # Use PyArrow pushdown predicate for high-speed scanning
                expr = (pc.field("series") == "EQ") & (pc.field("symbol").isin(symbols_set))
                table = pq.read_table(path, columns=columns, filters=expr)
            except Exception as exc:
                logger.warning("Failed to read partition %s: %s", path.name, exc)
                continue

            if table.num_rows == 0:
                continue

            pydict = table.to_pydict()
            row_count = table.num_rows

            for i in range(row_count):
                sym = pydict["symbol"][i]
                d_val = pydict["date"][i]
                rec_date = date.fromisoformat(d_val) if isinstance(d_val, str) else d_val

                raw_close = Decimal(str(pydict["close"][i]))
                raw_open = Decimal(str(pydict["open"][i]))
                raw_high = Decimal(str(pydict["high"][i]))
                raw_low = Decimal(str(pydict["low"][i]))
                adj_factor = Decimal(str(pydict["adj_factor_cumulative"][i] or 1.0))
                adj_close = Decimal(str(pydict["adj_close"][i] or raw_close * adj_factor))
                vol = int(pydict["volume"][i] or 0)
                isin = pydict["isin"][i]
                series = pydict["series"][i]

                rec = DailyEquityRecord(
                    date=rec_date,
                    symbol=sym,
                    series=series,
                    open=raw_open,
                    high=raw_high,
                    low=raw_low,
                    close=raw_close,
                    volume=vol,
                    adj_factor_cumulative=adj_factor,
                    adj_close=adj_close,
                    isin=isin,
                )
                if sym in results:
                    results[sym].append(rec)

        # Sort each symbol's records chronologically
        for sym in results:
            results[sym].sort(key=lambda r: r.date)

        return results

    async def get_reference_quote(self, symbol: str) -> MarketQuote:
        """Fetch current reference price quote with timestamp and freshness status."""
        norm_symbol = symbol.strip().upper()
        now_utc = self._get_now()

        # Synchronize if cache missing
        await self.sync_partitions_if_needed(now_utc)

        data_map = self._load_daily_records_for_symbols([norm_symbol], now_utc)
        records = data_map.get(norm_symbol, [])
        if not records:
            raise InstrumentNotFoundError(
                norm_symbol, f"Instrument '{norm_symbol}' not found in TejHQ market data."
            )

        latest_record = records[-1]
        latest_completed_session = self._calendar.get_latest_completed_trading_day(now_utc)

        # Staleness check against completed sessions
        is_stale = latest_record.date < latest_completed_session

        # Reference quote timestamp corresponds to session close at 15:30 IST
        quote_dt = datetime.combine(latest_record.date, NSE_MARKET_CLOSE_TIME, tzinfo=IST)

        return MarketQuote(
            symbol=norm_symbol,
            instrument_identifier=latest_record.isin or f"NSE_EQ|{norm_symbol}",
            last_price=latest_record.close,  # Raw unadjusted close
            timestamp=quote_dt,
            source="TEJHQ",
            is_stale=is_stale,
        )

    async def get_historical_weekly_candles(
        self,
        symbol: str,
        limit_weeks: int = 100,
    ) -> list[WeeklyCandle]:
        """Fetch historical weekly candles in chronological order."""
        norm_symbol = symbol.strip().upper()
        now_utc = self._get_now()

        await self.sync_partitions_if_needed(now_utc)

        data_map = self._load_daily_records_for_symbols([norm_symbol], now_utc)
        records = data_map.get(norm_symbol, [])
        if not records:
            raise InstrumentNotFoundError(
                norm_symbol, f"Instrument '{norm_symbol}' not found in TejHQ market data."
            )

        weekly_candles = self._aggregator.aggregate(records, norm_symbol, as_of=now_utc)
        if limit_weeks > 0 and len(weekly_candles) > limit_weeks:
            weekly_candles = weekly_candles[-limit_weeks:]

        return weekly_candles

    async def get_instrument_identifier(self, symbol: str) -> str | None:
        """Resolve an exchange symbol to the instrument identifier (ISIN or canonical key)."""
        norm_symbol = symbol.strip().upper()
        now_utc = self._get_now()
        data_map = self._load_daily_records_for_symbols([norm_symbol], now_utc)
        records = data_map.get(norm_symbol, [])
        if records and records[-1].isin:
            return records[-1].isin
        return f"NSE_EQ|{norm_symbol}"

    async def get_reference_quotes_batch(
        self,
        symbols: list[str],
    ) -> dict[str, MarketQuote]:
        """Fetch current reference price quotes for multiple symbols using optimized batch scan."""
        norm_symbols = [s.strip().upper() for s in symbols]
        now_utc = self._get_now()

        await self.sync_partitions_if_needed(now_utc)

        data_map = self._load_daily_records_for_symbols(norm_symbols, now_utc)
        latest_completed_session = self._calendar.get_latest_completed_trading_day(now_utc)

        quotes: dict[str, MarketQuote] = {}
        for sym, records in data_map.items():
            if not records:
                continue
            latest = records[-1]
            is_stale = latest.date < latest_completed_session
            quote_dt = datetime.combine(latest.date, NSE_MARKET_CLOSE_TIME, tzinfo=IST)
            quotes[sym] = MarketQuote(
                symbol=sym,
                instrument_identifier=latest.isin or f"NSE_EQ|{sym}",
                last_price=latest.close,  # Raw unadjusted close
                timestamp=quote_dt,
                source="TEJHQ",
                is_stale=is_stale,
            )

        return quotes

    def _build_isin_index_if_needed(self) -> dict[str, str]:
        """Build in-memory ISIN -> symbol index from cached Parquet partitions."""
        if self._isin_index is not None:
            return self._isin_index

        with self._index_lock:
            if self._isin_index is not None:
                return self._isin_index

            now_utc = self._get_now()
            required_years = self._get_required_years(now_utc)
            index: dict[str, str] = {}

            for year in required_years:
                path = self.get_partition_path(year)
                if not path.exists():
                    continue
                try:
                    expr = pc.field("series") == "EQ"
                    table = pq.read_table(path, columns=["symbol", "isin", "series"], filters=expr)
                    pydict = table.to_pydict()
                    for sym, isin in zip(pydict["symbol"], pydict["isin"]):
                        if isin and sym:
                            norm_isin = str(isin).strip().upper()
                            norm_sym = str(sym).strip().upper()
                            index[norm_isin] = norm_sym
                except Exception as exc:
                    logger.warning("Failed indexing ISINs from %s: %s", path.name, exc)

            self._isin_index = index
            return self._isin_index

    def resolve_by_isin(self, isin: str) -> tuple[str, str] | None:
        """Resolve an ISIN to (canonical_trading_symbol, instrument_key).

        Implements the InstrumentResolver protocol.
        """
        if not isin or not isin.strip():
            return None
        norm_isin = isin.strip().upper()
        index = self._build_isin_index_if_needed()
        sym = index.get(norm_isin)
        if not sym:
            return None
        return sym, f"NSE_EQ|{norm_isin}"
