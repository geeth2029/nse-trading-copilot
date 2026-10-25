"""In-memory typed caching layer with configurable TTLs and concurrent-request deduplication."""

import asyncio
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Generic, TypeVar

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class CacheEntry(Generic[T]):
    """Represents a cached item with explicit creation, expiry, and provider source timestamps."""

    data: T
    cached_at: datetime
    expires_at: datetime
    source_timestamp: datetime | None = None

    def is_expired(self, now: datetime | None = None) -> bool:
        current_time = now or datetime.now(timezone.utc)
        return current_time >= self.expires_at


class MarketDataCache:
    """Thread-safe / async-friendly in-memory cache for market data quotes and candle series."""

    def __init__(self) -> None:
        self._entries: dict[str, CacheEntry[Any]] = {}
        self._inflight_locks: dict[str, asyncio.Lock] = {}
        self._global_lock = asyncio.Lock()

    def get(self, key: str, now: datetime | None = None) -> Any | None:
        """Retrieves cached item if present and unexpired; returns None if missing or expired."""
        entry = self._entries.get(key)
        if entry is None:
            return None
        if entry.is_expired(now):
            # Proactively prune expired entry
            self._entries.pop(key, None)
            return None
        return entry.data

    def get_entry(self, key: str, now: datetime | None = None) -> CacheEntry[Any] | None:
        """Retrieves raw CacheEntry metadata for freshness inspection."""
        entry = self._entries.get(key)
        if entry is None:
            return None
        if entry.is_expired(now):
            self._entries.pop(key, None)
            return None
        return entry

    def set(
        self,
        key: str,
        data: Any,
        ttl_seconds: float,
        *,
        source_timestamp: datetime | None = None,
        now: datetime | None = None,
    ) -> None:
        """Stores data in memory with an explicit TTL and optional source timestamp."""
        current_time = now or datetime.now(timezone.utc)
        expires_at = datetime.fromtimestamp(current_time.timestamp() + ttl_seconds, tz=timezone.utc)
        self._entries[key] = CacheEntry(
            data=data,
            cached_at=current_time,
            expires_at=expires_at,
            source_timestamp=source_timestamp,
        )

    def invalidate(self, key: str) -> None:
        """Invalidates a specific cache key."""
        self._entries.pop(key, None)

    def clear(self) -> None:
        """Clears all cached entries and active inflight locks."""
        self._entries.clear()
        self._inflight_locks.clear()

    async def get_or_compute(
        self,
        key: str,
        fetcher: Callable[[], Coroutine[Any, Any, tuple[T, float, datetime | None]]],
    ) -> T:
        """Deduplicates concurrent requests for the same key (single-flight pattern).

        Fetcher must return a tuple of: (data, ttl_seconds, source_timestamp).
        """
        cached = self.get(key)
        if cached is not None:
            return cached

        async with self._global_lock:
            if key not in self._inflight_locks:
                self._inflight_locks[key] = asyncio.Lock()
            lock = self._inflight_locks[key]

        async with lock:
            # Double check after acquiring lock
            cached = self.get(key)
            if cached is not None:
                return cached

            data, ttl_seconds, source_timestamp = await fetcher()
            self.set(key, data, ttl_seconds, source_timestamp=source_timestamp)
            return data
