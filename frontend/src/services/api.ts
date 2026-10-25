import type {
  PortfolioPosition,
  PortfolioPositionResponse,
  PortfolioListResponse,
  PositionLifecycleStatus,
  PortfolioPositionCreatePayload,
  PyramidEntryCreatePayload,
  TradeEntryCreatePayload,
  PositionExitCreatePayload,
  PositionArchivePayload,
  MarketSnapshotRead,
  UniverseStatusRead,
  UniverseStatusType,
  ConstituentScreenResultRead,
  ConstituentDiagnosticStatus,
  UniverseScreenResponse,
} from '../types/trading';

export type {
  PortfolioPosition,
  PortfolioPositionResponse,
  PortfolioListResponse,
  PortfolioPositionCreatePayload,
  PyramidEntryCreatePayload,
  TradeEntryCreatePayload,
  PositionExitCreatePayload,
  PositionArchivePayload,
  MarketSnapshotRead,
  UniverseStatusRead,
  UniverseStatusType,
  ConstituentScreenResultRead,
  ConstituentDiagnosticStatus,
  UniverseScreenResponse,
};

/**
 * Structured API Error thrown for non-2xx HTTP responses.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly data?: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/**
 * Specific authentication failure error thrown when the backend returns HTTP 401.
 */
export class AuthenticationError extends ApiError {
  constructor(message = 'Authentication required.', data?: unknown) {
    super(401, message, data);
    this.name = 'AuthenticationError';
  }
}

/**
 * Network failure error thrown when fetch fails completely (e.g. offline, connection refused).
 */
export class NetworkError extends Error {
  readonly originalError?: unknown;

  constructor(message: string, originalError?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.originalError = originalError;
  }
}

export interface HealthResponse {
  status: 'ok' | string;
}

export interface UserRead {
  id: string;
  email: string;
  displayName?: string | null;
  createdAt: string;
}

export interface LogoutResponse {
  status: string;
}

/**
 * Reads a cookie value by name from document.cookie safely.
 * Returns null if running in non-browser environment or cookie is not present.
 */
export function getCookie(name: string): string | null {
  if (typeof document === 'undefined' || !document.cookie) {
    return null;
  }

  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      if (trimmed === name) return '';
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (key === name) {
      const rawVal = trimmed.slice(separatorIndex + 1);
      try {
        return decodeURIComponent(rawVal);
      } catch {
        return rawVal;
      }
    }
  }

  return null;
}

/**
 * Helper to construct JSON request headers with optional CSRF token from nse_csrf cookie.
 * If nse_csrf is not present, no fabricated token is sent.
 */
function createJsonWriteHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const csrfToken = getCookie('nse_csrf');
  if (csrfToken) {
    headers['x-csrf-token'] = csrfToken;
  }
  return headers;
}

/**
 * Internal helper for issuing authenticated JSON API requests.
 * Always includes credentials: 'include' for session cookie transmission.
 */
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...options,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...options.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed';
    throw new NetworkError(`Network request failed: ${message}`, error);
  }

  if (!response.ok) {
    let errorDetail = response.statusText || `Request failed with status ${response.status}`;
    let errorData: unknown;

    try {
      errorData = await response.json();
      if (errorData && typeof errorData === 'object' && 'detail' in errorData) {
        const detail = (errorData as { detail: unknown }).detail;
        if (typeof detail === 'string') {
          errorDetail = detail;
        } else if (detail !== undefined && detail !== null) {
          errorDetail = JSON.stringify(detail);
        }
      }
    } catch {
      // Body is not JSON, retain default status text
    }

    if (response.status === 401) {
      throw new AuthenticationError(errorDetail, errorData);
    }

    throw new ApiError(response.status, errorDetail, errorData);
  }

  return (await response.json()) as T;
}

/**
 * Checks backend availability via GET /health.
 */
export async function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health', { method: 'GET' });
}

/**
 * Fetches portfolio positions from GET /api/v1/portfolio/positions.
 * Supports optional lifecycle status filtering ('ACTIVE', 'COMPLETED', 'ARCHIVED').
 */
export async function fetchPortfolioPositions(
  status?: PositionLifecycleStatus
): Promise<PortfolioListResponse> {
  const url = status
    ? `/api/v1/portfolio/positions?status=${encodeURIComponent(status)}`
    : '/api/v1/portfolio/positions';

  return request<PortfolioListResponse>(url, { method: 'GET' });
}

/**
 * Fetches one specific user-owned portfolio position by ID.
 */
export async function fetchPortfolioPositionById(
  positionId: string
): Promise<PortfolioPositionResponse> {
  return request<PortfolioPositionResponse>(
    `/api/v1/portfolio/positions/${encodeURIComponent(positionId)}`,
    { method: 'GET' }
  );
}

/**
 * Creates an initial portfolio position and its initial trade entry via POST /api/v1/portfolio/positions.
 * Requires CSRF token and authenticated session. User identity is derived from session.
 */
export async function createPortfolioPosition(
  payload: PortfolioPositionCreatePayload
): Promise<PortfolioPositionResponse> {
  const bodyPayload: Record<string, unknown> = { ...payload };
  if (payload.executionPrice !== undefined && bodyPayload.execution_price === undefined) {
    bodyPayload.execution_price = payload.executionPrice;
  }
  if (
    payload.confirmReferencePriceAsExecution !== undefined &&
    bodyPayload.confirm_reference_price_as_execution === undefined
  ) {
    bodyPayload.confirm_reference_price_as_execution = payload.confirmReferencePriceAsExecution;
  }
  if (
    payload.acknowledgeInvalidRps !== undefined &&
    bodyPayload.acknowledge_invalid_rps === undefined
  ) {
    bodyPayload.acknowledge_invalid_rps = payload.acknowledgeInvalidRps;
  }
  return request<PortfolioPositionResponse>('/api/v1/portfolio/positions', {
    method: 'POST',
    headers: createJsonWriteHeaders(),
    body: JSON.stringify(bodyPayload),
  });
}

/**
 * Fetches verified market snapshot from GET /api/v1/market-data/snapshot/{symbol}.
 * Returns real-time reference quote and completed weekly indicators (20w SMA, weekly RSI).
 */
export async function fetchMarketSnapshot(symbol: string): Promise<MarketSnapshotRead> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  return request<MarketSnapshotRead>(
    `/api/v1/market-data/snapshot/${encodeURIComponent(normalizedSymbol)}`,
    { method: 'GET' }
  );
}

/**
 * Fetches operational availability, integrity, and validity status of the large-cap universe
 * via GET /api/v1/market-data/universe/largecap/status.
 */
export async function fetchLargeCapUniverseStatus(): Promise<UniverseStatusRead> {
  return request<UniverseStatusRead>('/api/v1/market-data/universe/largecap/status', {
    method: 'GET',
  });
}

/**
 * Screens the large-cap universe via GET /api/v1/market-data/universe/largecap/screen.
 * Supports optional qualified_only filtering on the server.
 */
export async function fetchLargeCapUniverseScreen(
  qualifiedOnly = false
): Promise<UniverseScreenResponse> {
  const query = qualifiedOnly ? '?qualified_only=true' : '';
  return request<UniverseScreenResponse>(
    `/api/v1/market-data/universe/largecap/screen${query}`,
    { method: 'GET' }
  );
}

/**
 * Adds a pyramid trade entry to an existing position via POST /api/v1/portfolio/positions/{id}/entries.
 * Requires CSRF token and authenticated session. User identity is derived from session.
 * In server-authoritative mode, payload contains user capital, optional notes, and execution price confirmation.
 */
export async function addPyramidEntry(
  positionId: string,
  payload: PyramidEntryCreatePayload | TradeEntryCreatePayload
): Promise<PortfolioPositionResponse> {
  const bodyPayload: Record<string, unknown> = { ...payload };
  if ('executionPrice' in payload && payload.executionPrice !== undefined && bodyPayload.execution_price === undefined) {
    bodyPayload.execution_price = payload.executionPrice;
  }
  if (
    'confirmReferencePriceAsExecution' in payload &&
    payload.confirmReferencePriceAsExecution !== undefined &&
    bodyPayload.confirm_reference_price_as_execution === undefined
  ) {
    bodyPayload.confirm_reference_price_as_execution = payload.confirmReferencePriceAsExecution;
  }
  if (
    'acknowledgeInvalidRps' in payload &&
    payload.acknowledgeInvalidRps !== undefined &&
    bodyPayload.acknowledge_invalid_rps === undefined
  ) {
    bodyPayload.acknowledge_invalid_rps = payload.acknowledgeInvalidRps;
  }
  return request<PortfolioPositionResponse>(
    `/api/v1/portfolio/positions/${encodeURIComponent(positionId)}/entries`,
    {
      method: 'POST',
      headers: createJsonWriteHeaders(),
      body: JSON.stringify(bodyPayload),
    }
  );
}

/**
 * Records an exit for the entire accumulated position via POST /api/v1/portfolio/positions/{id}/exit.
 * Requires CSRF token and authenticated session. User identity is derived from session.
 */
export async function recordPositionExit(
  positionId: string,
  payload: PositionExitCreatePayload
): Promise<PortfolioPositionResponse> {
  return request<PortfolioPositionResponse>(
    `/api/v1/portfolio/positions/${encodeURIComponent(positionId)}/exit`,
    {
      method: 'POST',
      headers: createJsonWriteHeaders(),
      body: JSON.stringify(payload),
    }
  );
}

/**
 * Archives a portfolio position via POST /api/v1/portfolio/positions/{id}/archive.
 * Requires CSRF token and authenticated session. User identity is derived from session.
 */
export async function archivePortfolioPosition(
  positionId: string,
  payload?: PositionArchivePayload
): Promise<PortfolioPositionResponse> {
  return request<PortfolioPositionResponse>(
    `/api/v1/portfolio/positions/${encodeURIComponent(positionId)}/archive`,
    {
      method: 'POST',
      headers: createJsonWriteHeaders(),
      body: JSON.stringify(payload ?? {}),
    }
  );
}

/**
 * Restores an archived portfolio position via POST /api/v1/portfolio/positions/{id}/restore.
 * Requires CSRF token and authenticated session. User identity is derived from session.
 */
export async function restorePortfolioPosition(
  positionId: string
): Promise<PortfolioPositionResponse> {
  return request<PortfolioPositionResponse>(
    `/api/v1/portfolio/positions/${encodeURIComponent(positionId)}/restore`,
    {
      method: 'POST',
      headers: createJsonWriteHeaders(),
    }
  );
}

/**
 * Fetches the currently authenticated user profile from GET /auth/me.
 */
export async function fetchCurrentUser(): Promise<UserRead> {
  return request<UserRead>('/auth/me', { method: 'GET' });
}

/**
 * Authenticates user credentials via POST /auth/login.
 * On success, backend sets session & csrf cookies.
 */
export async function login(email: string, password: string): Promise<UserRead> {
  return request<UserRead>('/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
}

/**
 * Registers a new user account via POST /auth/register.
 * On success, backend sets session & csrf cookies.
 */
export async function register(
  email: string,
  password: string,
  displayName?: string | null
): Promise<UserRead> {
  const payload: { email: string; password: string; displayName?: string | null } = {
    email,
    password,
  };
  if (displayName !== undefined && displayName !== null) {
    payload.displayName = displayName;
  }

  return request<UserRead>('/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Terminates the current session via POST /auth/logout.
 * Reads the nse_csrf cookie and sends it in the x-csrf-token header.
 * If nse_csrf is not present, no fabricated token is sent.
 */
export async function logout(): Promise<LogoutResponse> {
  return request<LogoutResponse>('/auth/logout', {
    method: 'POST',
    headers: createJsonWriteHeaders(),
  });
}

