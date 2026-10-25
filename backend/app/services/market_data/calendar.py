"""NSE Exchange Trading Calendar and Weekly Candle Completion Policy."""

from datetime import date, datetime, time, timedelta, timezone

# Indian Standard Time (UTC+05:30)
IST = timezone(timedelta(hours=5, minutes=30))

# NSE Regular Equity Market Closing Time
NSE_MARKET_CLOSE_TIME = time(15, 30)

# Verified NSE Official Equity Trading Holidays (2024, 2025, 2026)
# Sources: NSE Official Trading Holiday Circulars
VERIFIED_NSE_HOLIDAYS: set[date] = {
    # 2024
    date(2024, 1, 22),   # Special Ram Mandir Holiday
    date(2024, 1, 26),   # Republic Day (Friday)
    date(2024, 3, 8),    # Maha Shivratri (Friday)
    date(2024, 3, 25),   # Holi (Monday)
    date(2024, 3, 29),   # Good Friday (Friday)
    date(2024, 4, 11),   # Id-Ul-Fitr (Thursday)
    date(2024, 4, 17),   # Shri Ram Navami (Wednesday)
    date(2024, 5, 1),    # Maharashtra Day (Wednesday)
    date(2024, 5, 20),   # General Parliamentary Elections (Monday)
    date(2024, 6, 17),   # Bakri Id (Monday)
    date(2024, 7, 17),   # Muharram (Wednesday)
    date(2024, 8, 15),   # Independence Day (Thursday)
    date(2024, 10, 2),   # Mahatma Gandhi Jayanti (Wednesday)
    date(2024, 11, 1),   # Diwali Laxmi Pujan (Friday)
    date(2024, 11, 15),  # Guru Nanak Jayanti (Friday)
    date(2024, 11, 20),  # Maharashtra Assembly Elections (Wednesday)
    date(2024, 12, 25),  # Christmas (Wednesday)

    # 2025
    date(2025, 2, 26),   # Maha Shivratri (Wednesday)
    date(2025, 3, 14),   # Holi (Friday)
    date(2025, 3, 31),   # Id-Ul-Fitr (Monday)
    date(2025, 4, 10),   # Shri Mahavir Jayanti (Thursday)
    date(2025, 4, 14),   # Dr. Baba Saheb Ambedkar Jayanti (Monday)
    date(2025, 4, 18),   # Good Friday (Friday)
    date(2025, 5, 1),    # Maharashtra Day (Thursday)
    date(2025, 8, 15),   # Independence Day (Friday)
    date(2025, 8, 27),   # Ganesh Chaturthi (Wednesday)
    date(2025, 10, 2),   # Mahatma Gandhi Jayanti / Dussehra (Thursday)
    date(2025, 10, 21),  # Diwali Balipratipada (Tuesday)
    date(2025, 11, 5),   # Guru Nanak Jayanti (Wednesday)
    date(2025, 12, 25),  # Christmas (Thursday)

    # 2026
    date(2026, 1, 26),   # Republic Day (Monday)
    date(2026, 3, 4),    # Holi (Wednesday)
    date(2026, 3, 20),   # Id-ul-Fitr (Friday)
    date(2026, 4, 3),    # Good Friday (Friday)
    date(2026, 4, 14),   # Ambedkar Jayanti (Tuesday)
    date(2026, 5, 1),    # Maharashtra Day (Friday)
    date(2026, 5, 27),   # Bakri Id (Wednesday)
    date(2026, 10, 2),   # Mahatma Gandhi Jayanti (Friday)
    date(2026, 10, 20),  # Dussehra (Tuesday)
    date(2026, 11, 9),   # Diwali Balipratipada (Monday)
    date(2026, 12, 25),  # Christmas (Friday)
}


class NSETradingCalendar:
    """NSE Equity trading calendar with holiday tracking and weekly session resolution.

    Handles:
    - Normal Friday closes (15:30 IST).
    - Friday exchange holidays (settles on Thursday 15:30 IST).
    - Shortened trading weeks.
    - Resolving week start (Monday) timestamps to week closing session dates.
    - Conservative fallback when calendar is unverified for future or unknown years.
    """

    def __init__(self, holidays: set[date] | None = None) -> None:
        self._holidays = set(holidays) if holidays is not None else VERIFIED_NSE_HOLIDAYS

    @property
    def holidays(self) -> set[date]:
        return self._holidays

    def is_trading_day(self, d: date) -> bool:
        """Return True if the given date is a weekday and not an exchange holiday."""
        if d.weekday() >= 5:  # Saturday or Sunday
            return False
        return d not in self._holidays

    def get_weekly_trading_days(self, any_date_in_week: date) -> list[date]:
        """Return all scheduled trading days for the week containing any_date_in_week (Monday=0 to Friday=4)."""
        monday = any_date_in_week - timedelta(days=any_date_in_week.weekday())
        week_days = [monday + timedelta(days=i) for i in range(5)]
        return [d for d in week_days if self.is_trading_day(d)]

    def get_weekly_closing_date(self, any_date_in_week: date) -> date:
        """Resolve the official closing session date for the week containing any_date_in_week.

        For a standard week, this is Friday.
        If Friday is an exchange holiday, it resolves to Thursday (or the last valid trading day).
        If the entire week has no trading days (extreme edge case), defaults to Friday.
        """
        trading_days = self.get_weekly_trading_days(any_date_in_week)
        if trading_days:
            return trading_days[-1]
        # Fallback to Friday of that week
        monday = any_date_in_week - timedelta(days=any_date_in_week.weekday())
        return monday + timedelta(days=4)

    def get_latest_completed_trading_day(self, now: datetime | None = None) -> date:
        """Resolve the official date of the most recent completed NSE trading session.

        Rules:
        - If now_ist falls on a scheduled trading day (weekday not in exchange holidays):
          - If now_ist.time() >= 15:30 IST, today's trading session has completed; returns today.
          - If now_ist.time() < 15:30 IST, today's trading session is ongoing or has not opened;
            searches backward for the previous completed trading day.
        - If now_ist falls on a weekend or an exchange holiday:
          - Searches backward for the most recent trading day.
        """
        now_ist = (now or datetime.now(timezone.utc)).astimezone(IST)
        today = now_ist.date()

        if self.is_trading_day(today) and now_ist.time() >= NSE_MARKET_CLOSE_TIME:
            return today

        candidate = today - timedelta(days=1)
        while not self.is_trading_day(candidate):
            candidate -= timedelta(days=1)
        return candidate

    def is_week_completed(
        self,
        candle_date: date,
        now: datetime | None = None,
    ) -> bool:
        """Determine whether the weekly session for candle_date is definitively completed.

        Rules:
        1. Past calendar weeks: If now_ist has moved to a subsequent calendar week
           (at or after next Monday 00:00 IST), all trading for the candle's week
           has definitively ended, regardless of holidays. Returns True.
        2. Current forming week:
           - If calendar coverage exists for this week, finds the verified last trading day.
             The session completes at 15:30 IST on that day.
             If now_ist < weekly_session_close, returns False (week is forming).
             If now_ist >= weekly_session_close, returns True (last trading session has concluded).
           - Conservative fallback: If the week's holiday schedule cannot be authoritatively
             established (e.g. unknown calendar year beyond verified scope), returns False
             until the week has fully transitioned to the next calendar week. Never guesses.
        3. Future weeks: Returns False.
        """
        now_ist = (now or datetime.now(timezone.utc)).astimezone(IST)
        now_date = now_ist.date()

        monday = candle_date - timedelta(days=candle_date.weekday())
        next_monday = monday + timedelta(days=7)

        # 1. Past calendar weeks
        if now_date >= next_monday:
            return True

        # 3. Future candle
        if now_date < monday:
            return False

        # 2. Current calendar week
        # Check if year is within verified calendar coverage
        year = monday.year
        verified_years = {d.year for d in self._holidays}
        if year not in verified_years:
            # Conservative fallback: completion cannot be established without verified calendar.
            # Exclude candle from indicators until the week has fully elapsed.
            return False

        trading_days = self.get_weekly_trading_days(candle_date)
        if not trading_days:
            # No trading days in this week; cannot establish completion
            return False

        last_trading_day = trading_days[-1]
        weekly_session_close = datetime.combine(last_trading_day, NSE_MARKET_CLOSE_TIME, tzinfo=IST)

        # Completed strictly if now_ist is at or after the last session's close time
        return now_ist >= weekly_session_close
