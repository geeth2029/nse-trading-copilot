import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  AuthenticationError,
  NetworkError,
  fetchHealth,
  fetchPortfolioPositions,
  fetchPortfolioPositionById,
  createPortfolioPosition,
  addPyramidEntry,
  recordPositionExit,
  archivePortfolioPosition,
  fetchMarketSnapshot,
} from '../services/api';
import type {
  PortfolioPositionResponse,
  PortfolioPositionCreatePayload,
  TradeEntryCreatePayload,
  PositionExitCreatePayload,
  PositionArchivePayload,
  MarketSnapshotRead,
} from '../types/trading';

describe('Frontend API Connection Layer (services/api.ts)', () => {
  const originalFetch = globalThis.fetch;
  let mockCookieStore = '';

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCookieStore = '';

    if (typeof globalThis.document === 'undefined') {
      Object.defineProperty(globalThis, 'document', {
        value: {
          get cookie() {
            return mockCookieStore;
          },
          set cookie(val: string) {
            mockCookieStore = val;
          },
        },
        writable: true,
        configurable: true,
      });
    } else {
      Object.defineProperty(globalThis.document, 'cookie', {
        get() {
          return mockCookieStore;
        },
        set(val: string) {
          mockCookieStore = val;
        },
        configurable: true,
      });
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockCookieStore = '';
  });


  const mockPositionWithNulls: PortfolioPositionResponse = {
    id: 'pos-101',
    symbol: 'BHARTIARTL',
    companyName: 'Bharti Airtel Limited',
    status: 'ACTIVE',
    initialEntryDate: '2026-09-12',
    entries: [
      {
        id: 'entry-1',
        positionId: 'pos-101',
        sequence: 1,
        entryType: 'INITIAL_ENTRY',
        entryDate: '2026-09-12',
        entryPrice: 1570,
        stopLoss: 1510,
        rps: 60,
        rpt: 10200,
        quantity: 170,
        capitalSnapshot: 1020000,
        sizingStatus: 'VALID',
        entryPnl: null,
        notes: 'Initial entry',
      },
    ],
    exit: null,
    accumulatedQuantity: 170,
    averageEntryPrice: 1570,
    totalCapitalDeployed: 266900,
    currentReferencePrice: null,
    twentyWeekSmaStopLoss: null,
    latestWeeklyRsi: null,
    isPyramidEligible: null,
    realizedPnl: null,
    unrealizedPnl: null,
    archivedAt: null,
    archiveReason: null,
    createdAt: '2026-09-12T10:00:00Z',
  };

  describe('fetchHealth', () => {
    it('returns status ok on 200 and includes credentials', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      } as Response);
      globalThis.fetch = mockFetch;

      const result = await fetchHealth();

      expect(result).toEqual({ status: 'ok' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/health');
      expect(options.credentials).toBe('include');
    });

    it('throws ApiError with status and message on 503', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ detail: 'Service temporarily down for maintenance' }),
      } as Response);

      await expect(fetchHealth()).rejects.toThrow(ApiError);

      try {
        await fetchHealth();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(503);
        expect(apiErr.message).toBe('Service temporarily down for maintenance');
      }
    });

    it('throws NetworkError when fetch rejects', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(fetchHealth()).rejects.toThrow(NetworkError);

      try {
        await fetchHealth();
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkError);
        expect((err as NetworkError).message).toContain('Failed to fetch');
      }
    });
  });

  describe('fetchPortfolioPositions', () => {
    it('successfully fetches all positions with credentials: include and preserves nullable fields', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ positions: [mockPositionWithNulls] }),
      } as Response);
      globalThis.fetch = mockFetch;

      const result = await fetchPortfolioPositions();

      expect(result.positions).toHaveLength(1);
      const pos = result.positions[0];
      expect(pos.id).toBe('pos-101');
      // Crucial: check nullable fields are explicitly null, not converted to 0 or false
      expect(pos.currentReferencePrice).toBeNull();
      expect(pos.twentyWeekSmaStopLoss).toBeNull();
      expect(pos.latestWeeklyRsi).toBeNull();
      expect(pos.isPyramidEligible).toBeNull();
      expect(pos.unrealizedPnl).toBeNull();
      expect(pos.realizedPnl).toBeNull();
      expect(pos.exit).toBeNull();
      expect(pos.archivedAt).toBeNull();
      expect(pos.archiveReason).toBeNull();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/portfolio/positions');
      expect(options.credentials).toBe('include');
    });

    it('appends status query parameter when filtered by status', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ positions: [mockPositionWithNulls] }),
      } as Response);
      globalThis.fetch = mockFetch;

      await fetchPortfolioPositions('ACTIVE');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/portfolio/positions?status=ACTIVE');
    });

    it('filters correctly for COMPLETED and ARCHIVED statuses', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ positions: [] }),
      } as Response);
      globalThis.fetch = mockFetch;

      await fetchPortfolioPositions('COMPLETED');
      expect(mockFetch.mock.calls[0][0]).toBe('/api/v1/portfolio/positions?status=COMPLETED');

      await fetchPortfolioPositions('ARCHIVED');
      expect(mockFetch.mock.calls[1][0]).toBe('/api/v1/portfolio/positions?status=ARCHIVED');
    });

    it('explicitly throws AuthenticationError on HTTP 401', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ detail: 'Authentication required.' }),
      } as Response);

      await expect(fetchPortfolioPositions()).rejects.toThrow(AuthenticationError);

      try {
        await fetchPortfolioPositions();
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect(err).toBeInstanceOf(ApiError);
        const authErr = err as AuthenticationError;
        expect(authErr.status).toBe(401);
        expect(authErr.message).toBe('Authentication required.');
      }
    });

    it('throws ApiError on HTTP 422 with validation detail', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ detail: 'Input should be ACTIVE, COMPLETED, or ARCHIVED' }),
      } as Response);

      await expect(fetchPortfolioPositions()).rejects.toThrow(ApiError);

      try {
        await fetchPortfolioPositions();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(422);
        expect((err as ApiError).message).toBe('Input should be ACTIVE, COMPLETED, or ARCHIVED');
      }
    });

    it('throws NetworkError on network disconnection', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network connection lost'));

      await expect(fetchPortfolioPositions()).rejects.toThrow(NetworkError);

      try {
        await fetchPortfolioPositions();
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkError);
        expect((err as NetworkError).message).toContain('Network connection lost');
      }
    });
  });

  describe('fetchPortfolioPositionById', () => {
    it('fetches single position by ID successfully and preserves nullable fields', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockPositionWithNulls,
      } as Response);
      globalThis.fetch = mockFetch;

      const result = await fetchPortfolioPositionById('pos-101');

      expect(result).toEqual(mockPositionWithNulls);
      expect(result.currentReferencePrice).toBeNull();
      expect(result.latestWeeklyRsi).toBeNull();
      expect(result.twentyWeekSmaStopLoss).toBeNull();
      expect(result.isPyramidEligible).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/portfolio/positions/pos-101');
      expect(options.credentials).toBe('include');
    });

    it('throws ApiError on HTTP 404 when position is not found', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ detail: 'Position not found.' }),
      } as Response);

      await expect(fetchPortfolioPositionById('unknown-pos')).rejects.toThrow(ApiError);

      try {
        await fetchPortfolioPositionById('unknown-pos');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.message).toBe('Position not found.');
      }
    });

    it('throws AuthenticationError on HTTP 401', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ detail: 'Session expired.' }),
      } as Response);

      await expect(fetchPortfolioPositionById('pos-123')).rejects.toThrow(AuthenticationError);

      try {
        await fetchPortfolioPositionById('pos-123');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as AuthenticationError).status).toBe(401);
        expect((err as AuthenticationError).message).toBe('Session expired.');
      }
    });
  });

  describe('createPortfolioPosition', () => {
    const createPayload: PortfolioPositionCreatePayload = {
      symbol: 'BHARTIARTL',
      initialEntry: {
        sequence: 1,
        entryType: 'INITIAL_ENTRY',
        entryDate: '2026-09-12',
        entryPrice: 1570,
        stopLoss: 1510,
        rps: 60,
        rpt: 10200,
        quantity: 170,
        capitalSnapshot: 1020000,
        sizingStatus: 'VALID',
        notes: 'Initial entry sized at 1% RPT',
      },
    };

    it('sends POST /api/v1/portfolio/positions with payload and CSRF header', async () => {
      document.cookie = 'nse_csrf=csrf-secret-123; path=/';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => mockPositionWithNulls,
      } as Response);
      globalThis.fetch = mockFetch;

      const result = await createPortfolioPosition(createPayload);

      expect(result).toEqual(mockPositionWithNulls);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/portfolio/positions');
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('include');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['x-csrf-token']).toBe('csrf-secret-123');
      expect(JSON.parse(options.body)).toEqual(createPayload);
    });

    it('omits x-csrf-token header when nse_csrf cookie is absent', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => mockPositionWithNulls,
      } as Response);
      globalThis.fetch = mockFetch;

      await createPortfolioPosition(createPayload);

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['x-csrf-token']).toBeUndefined();
    });

    it('throws ApiError on HTTP 404 when instrument is not found', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ detail: "Instrument 'UNKNOWN' not found." }),
      } as Response);

      await expect(
        createPortfolioPosition({ ...createPayload, symbol: 'UNKNOWN' })
      ).rejects.toThrow(ApiError);

      try {
        await createPortfolioPosition({ ...createPayload, symbol: 'UNKNOWN' });
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(404);
        expect((err as ApiError).message).toBe("Instrument 'UNKNOWN' not found.");
      }
    });

    it('throws ApiError on HTTP 409 when active position already exists', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: async () => ({ detail: 'An active position already exists for BHARTIARTL.' }),
      } as Response);

      await expect(createPortfolioPosition(createPayload)).rejects.toThrow(ApiError);

      try {
        await createPortfolioPosition(createPayload);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(409);
        expect((err as ApiError).message).toBe('An active position already exists for BHARTIARTL.');
      }
    });

    it('throws ApiError on HTTP 422 for invalid entry parameters', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({
          detail: "Initial entry must have sequence 1 and entry_type 'INITIAL_ENTRY'.",
        }),
      } as Response);

      await expect(createPortfolioPosition(createPayload)).rejects.toThrow(ApiError);

      try {
        await createPortfolioPosition(createPayload);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(422);
        expect((err as ApiError).message).toBe(
          "Initial entry must have sequence 1 and entry_type 'INITIAL_ENTRY'."
        );
      }
    });
  });

  describe('addPyramidEntry', () => {
    const pyramidPayload: TradeEntryCreatePayload = {
      sequence: 2,
      entryType: 'PYRAMID_ENTRY',
      entryDate: '2026-10-18',
      entryPrice: 1670,
      stopLoss: 1590,
      rps: 80,
      rpt: 8800,
      quantity: 110,
      capitalSnapshot: 880000,
      sizingStatus: 'VALID',
      notes: 'Pyramid step 1',
    };

    it('sends POST /api/v1/portfolio/positions/{id}/entries with correct payload and CSRF header', async () => {
      document.cookie = 'nse_csrf=csrf-token-abc; path=/';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => mockPositionWithNulls,
      } as Response);
      globalThis.fetch = mockFetch;

      const result = await addPyramidEntry('pos-101', pyramidPayload);

      expect(result).toEqual(mockPositionWithNulls);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/portfolio/positions/pos-101/entries');
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('include');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['x-csrf-token']).toBe('csrf-token-abc');
      expect(JSON.parse(options.body)).toEqual(pyramidPayload);
    });

    it('throws ApiError on HTTP 409 when adding pyramid to inactive or exited position', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: async () => ({ detail: 'Cannot add pyramid entries to an exited or archived position.' }),
      } as Response);

      await expect(addPyramidEntry('pos-101', pyramidPayload)).rejects.toThrow(ApiError);

      try {
        await addPyramidEntry('pos-101', pyramidPayload);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(409);
        expect((err as ApiError).message).toBe(
          'Cannot add pyramid entries to an exited or archived position.'
        );
      }
    });

    it('throws ApiError on HTTP 422 for sequence mismatch', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ detail: "Pyramid entry must have sequence 2 and entry_type 'PYRAMID_ENTRY'." }),
      } as Response);

      await expect(addPyramidEntry('pos-101', pyramidPayload)).rejects.toThrow(ApiError);

      try {
        await addPyramidEntry('pos-101', pyramidPayload);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(422);
        expect((err as ApiError).message).toBe(
          "Pyramid entry must have sequence 2 and entry_type 'PYRAMID_ENTRY'."
        );
      }
    });

    it('throws ApiError on HTTP 404 when position is not found', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ detail: 'Position not found.' }),
      } as Response);

      await expect(addPyramidEntry('pos-unknown', pyramidPayload)).rejects.toThrow(ApiError);
    });
  });

  describe('recordPositionExit', () => {
    const exitPayload: PositionExitCreatePayload = {
      exitPrice: 1720,
      exitDate: '2026-10-24',
      notes: 'Weekly RSI fell below 60.0, booked full profit',
    };

    it('sends POST /api/v1/portfolio/positions/{id}/exit with correct payload and CSRF header', async () => {
      document.cookie = 'nse_csrf=csrf-exit-token; path=/';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ...mockPositionWithNulls, status: 'COMPLETED' }),
      } as Response);
      globalThis.fetch = mockFetch;

      const result = await recordPositionExit('pos-101', exitPayload);

      expect(result.status).toBe('COMPLETED');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/portfolio/positions/pos-101/exit');
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('include');
      expect(options.headers['x-csrf-token']).toBe('csrf-exit-token');
      expect(JSON.parse(options.body)).toEqual(exitPayload);
    });

    it('throws ApiError on HTTP 409 when exit is already recorded', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: async () => ({ detail: 'An exit has already been recorded for this position.' }),
      } as Response);

      await expect(recordPositionExit('pos-101', exitPayload)).rejects.toThrow(ApiError);

      try {
        await recordPositionExit('pos-101', exitPayload);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(409);
        expect((err as ApiError).message).toBe(
          'An exit has already been recorded for this position.'
        );
      }
    });

    it('throws ApiError on HTTP 422 when exit date precedes initial entry date', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ detail: 'Exit date cannot precede initial entry date.' }),
      } as Response);

      await expect(
        recordPositionExit('pos-101', { ...exitPayload, exitDate: '2026-08-01' })
      ).rejects.toThrow(ApiError);

      try {
        await recordPositionExit('pos-101', { ...exitPayload, exitDate: '2026-08-01' });
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(422);
        expect((err as ApiError).message).toBe('Exit date cannot precede initial entry date.');
      }
    });

    it('throws ApiError on HTTP 404 when position is not found', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ detail: 'Position not found.' }),
      } as Response);

      await expect(recordPositionExit('unknown', exitPayload)).rejects.toThrow(ApiError);
    });
  });

  describe('archivePortfolioPosition', () => {
    const archivePayload: PositionArchivePayload = {
      reason: 'User archived completed position',
    };

    it('sends POST /api/v1/portfolio/positions/{id}/archive with payload and CSRF header', async () => {
      document.cookie = 'nse_csrf=csrf-archive-token; path=/';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ...mockPositionWithNulls, status: 'ARCHIVED' }),
      } as Response);
      globalThis.fetch = mockFetch;

      const result = await archivePortfolioPosition('pos-101', archivePayload);

      expect(result.status).toBe('ARCHIVED');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/portfolio/positions/pos-101/archive');
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('include');
      expect(options.headers['x-csrf-token']).toBe('csrf-archive-token');
      expect(JSON.parse(options.body)).toEqual(archivePayload);
    });

    it('sends empty object body when payload is omitted', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ...mockPositionWithNulls, status: 'ARCHIVED' }),
      } as Response);
      globalThis.fetch = mockFetch;

      await archivePortfolioPosition('pos-101');

      const [, options] = mockFetch.mock.calls[0];
      expect(JSON.parse(options.body)).toEqual({});
    });

    it('throws ApiError on HTTP 404 when position is not found', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ detail: 'Position not found.' }),
      } as Response);

      await expect(archivePortfolioPosition('pos-unknown')).rejects.toThrow(ApiError);

      try {
        await archivePortfolioPosition('pos-unknown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(404);
        expect((err as ApiError).message).toBe('Position not found.');
      }
    });

    it('throws AuthenticationError on HTTP 401', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ detail: 'Authentication required.' }),
      } as Response);

      await expect(archivePortfolioPosition('pos-101')).rejects.toThrow(AuthenticationError);
    });
  });

  describe('fetchMarketSnapshot(symbol)', () => {
    const mockSnapshot: MarketSnapshotRead = {
      symbol: 'RELIANCE',
      instrumentIdentifier: 'NSE_EQ|INE002A01018',
      lastPrice: 2845.5,
      quoteTimestamp: '2026-10-23T15:30:00+05:30',
      twentyWeekSma: 2710.25,
      weeklyRsi: 64.8,
      latestCompletedCandleDate: '2026-10-16',
      completedCandlesCount: 22,
      isStale: false,
      isEligibleForInitial: true,
      statusReason: 'Qualified for initial entry: RSI 64.8 > 60 and price ₹2845.50 > 20w SMA ₹2710.25',
      source: 'Upstox API (NSE)',
    };

    it('calls GET /api/v1/market-data/snapshot/{symbol} with credentials: include and uppercase trimmed symbol', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockSnapshot,
      } as Response);
      globalThis.fetch = mockFetch;

      const result = await fetchMarketSnapshot(' reliance ');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/v1/market-data/snapshot/RELIANCE');
      expect(options.method).toBe('GET');
      expect(options.credentials).toBe('include');
      expect(result).toEqual(mockSnapshot);
      expect(result.source).toBe('Upstox API (NSE)');
      expect(result.isStale).toBe(false);
      expect(result.twentyWeekSma).toBe(2710.25);
      expect(result.weeklyRsi).toBe(64.8);
    });

    it('preserves unavailable and stale states without manufacturing data', async () => {
      const staleSnapshot: MarketSnapshotRead = {
        symbol: 'TCS',
        instrumentIdentifier: 'NSE_EQ|INE467B01029',
        lastPrice: 4120.0,
        quoteTimestamp: '2026-10-23T15:00:00+05:30',
        twentyWeekSma: null,
        weeklyRsi: null,
        latestCompletedCandleDate: null,
        completedCandlesCount: 12,
        isStale: true,
        isEligibleForInitial: false,
        statusReason: 'Insufficient weekly candle history (12/20 required)',
        source: 'Upstox API (NSE)',
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => staleSnapshot,
      } as Response);

      const result = await fetchMarketSnapshot('TCS');

      expect(result.isStale).toBe(true);
      expect(result.twentyWeekSma).toBeNull();
      expect(result.weeklyRsi).toBeNull();
      expect(result.isEligibleForInitial).toBe(false);
    });

    it('throws ApiError on HTTP 404 when instrument is not found', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ detail: "Instrument 'UNKNOWN' not found in NSE master." }),
      } as Response);

      await expect(fetchMarketSnapshot('UNKNOWN')).rejects.toThrow(ApiError);
    });

    it('throws ApiError on HTTP 503 when market data service is unavailable or upstream provider fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ detail: 'Verified market data unavailable: Provider connection failed.' }),
      } as Response);

      await expect(fetchMarketSnapshot('INFY')).rejects.toThrow(ApiError);
    });

    it('throws ApiError on HTTP 429 when rate limit is exceeded', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ detail: 'Market data provider rate limit exceeded. Please retry later.' }),
      } as Response);

      await expect(fetchMarketSnapshot('HDFCBANK')).rejects.toThrow(ApiError);
    });

    it('throws AuthenticationError on HTTP 401 when session has expired', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ detail: 'Authentication required or session expired.' }),
      } as Response);

      await expect(fetchMarketSnapshot('RELIANCE')).rejects.toThrow(AuthenticationError);
    });
  });
});
