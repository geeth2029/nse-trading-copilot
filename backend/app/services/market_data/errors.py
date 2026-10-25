"""Typed exception hierarchy for the market data service."""


class MarketDataError(Exception):
    """Base exception for all market data provider and calculation errors."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class ProviderAuthenticationError(MarketDataError):
    """Raised when provider credentials are missing, rejected (HTTP 401/403), or expired."""

    def __init__(self, message: str = "Provider authentication failed.") -> None:
        super().__init__(message, status_code=401)


class RateLimitExceededError(MarketDataError):
    """Raised when the provider rate limit is exceeded (HTTP 429)."""

    def __init__(
        self,
        message: str = "Provider rate limit exceeded.",
        *,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message, status_code=429)
        self.retry_after = retry_after


class InstrumentNotFoundError(MarketDataError):
    """Raised when an instrument symbol cannot be resolved or is ambiguous."""

    def __init__(self, symbol: str, details: str = "Instrument not found in provider master.") -> None:
        super().__init__(f"Instrument '{symbol}' not found: {details}", status_code=404)
        self.symbol = symbol


class MarketDataUnavailableError(MarketDataError):
    """Raised when market data is temporarily unavailable due to timeouts, network, or provider errors (HTTP 5xx)."""

    def __init__(self, message: str = "Market data is temporarily unavailable.") -> None:
        super().__init__(message, status_code=503)


class MalformedDataError(MarketDataError):
    """Raised when provider response data is malformed, corrupted, or missing required fields."""

    def __init__(self, message: str = "Malformed or unparseable market data received.") -> None:
        super().__init__(message, status_code=502)


class StaleDataError(MarketDataError):
    """Raised when received quote data is determined to be older than the acceptable freshness SLA."""

    def __init__(self, message: str = "Market data quote is stale.") -> None:
        super().__init__(message, status_code=504)
