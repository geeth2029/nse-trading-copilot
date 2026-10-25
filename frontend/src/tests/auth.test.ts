import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  AuthenticationError,
  NetworkError,
  fetchCurrentUser,
  login,
  register,
  logout,
  getCookie,
  type UserRead,
} from '../services/api';

describe('Frontend Authentication Client (services/api.ts)', () => {
  const originalFetch = globalThis.fetch;
  let mockCookieStore = '';

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCookieStore = '';

    // Mock document.cookie cleanly in both node and browser environments
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
  });

  const sampleUser: UserRead = {
    id: 'user-uuid-1',
    email: 'trader@example.com',
    displayName: 'Active Trader',
    createdAt: '2026-10-24T10:00:00Z',
  };

  describe('getCookie utility', () => {
    it('returns null when document is undefined or cookie is empty', () => {
      mockCookieStore = '';
      expect(getCookie('nse_csrf')).toBeNull();
    });

    it('returns correct value when cookie exists among multiple cookies', () => {
      mockCookieStore = 'theme=dark; nse_csrf=csrf-token-abc-123; session_hint=true';
      expect(getCookie('nse_csrf')).toBe('csrf-token-abc-123');
      expect(getCookie('theme')).toBe('dark');
      expect(getCookie('nonexistent')).toBeNull();
    });

    it('decodes encoded cookie values', () => {
      mockCookieStore = 'special=hello%20world%21';
      expect(getCookie('special')).toBe('hello world!');
    });
  });

  describe('fetchCurrentUser (GET /auth/me)', () => {
    it('successfully retrieves current user with credentials: include', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleUser,
      } as Response);
      globalThis.fetch = mockFetch;

      const user = await fetchCurrentUser();

      expect(user).toEqual(sampleUser);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/auth/me');
      expect(options.method).toBe('GET');
      expect(options.credentials).toBe('include');
    });

    it('throws AuthenticationError on HTTP 401 (Authentication required)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ detail: 'Authentication required.' }),
      } as Response);

      await expect(fetchCurrentUser()).rejects.toThrow(AuthenticationError);

      try {
        await fetchCurrentUser();
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as AuthenticationError).status).toBe(401);
        expect((err as AuthenticationError).message).toBe('Authentication required.');
      }
    });

    it('throws AuthenticationError on HTTP 401 (Session expired)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ detail: 'Session expired.' }),
      } as Response);

      try {
        await fetchCurrentUser();
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as AuthenticationError).status).toBe(401);
        expect((err as AuthenticationError).message).toBe('Session expired.');
      }
    });

    it('throws NetworkError when fetch rejects', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(fetchCurrentUser()).rejects.toThrow(NetworkError);
    });
  });

  describe('login (POST /auth/login)', () => {
    it('sends credentials as JSON body and includes credentials: include', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleUser,
      } as Response);
      globalThis.fetch = mockFetch;

      const user = await login('trader@example.com', 'correct horse battery staple');

      expect(user).toEqual(sampleUser);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/auth/login');
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('include');
      expect(options.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(JSON.parse(options.body as string)).toEqual({
        email: 'trader@example.com',
        password: 'correct horse battery staple',
      });
    });

    it('throws AuthenticationError on invalid credentials (HTTP 401)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ detail: 'Invalid email or password.' }),
      } as Response);

      await expect(login('trader@example.com', 'wrongpassword')).rejects.toThrow(
        AuthenticationError
      );

      try {
        await login('trader@example.com', 'wrongpassword');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as AuthenticationError).status).toBe(401);
        expect((err as AuthenticationError).message).toBe('Invalid email or password.');
      }
    });

    it('throws ApiError on HTTP 422 input validation failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ detail: 'value is not a valid email address' }),
      } as Response);

      await expect(login('invalid-email', 'pwd')).rejects.toThrow(ApiError);

      try {
        await login('invalid-email', 'pwd');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(422);
        expect((err as ApiError).message).toBe('value is not a valid email address');
      }
    });

    it('throws ApiError on HTTP 403 Same-origin failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ detail: 'Same-origin request required.' }),
      } as Response);

      try {
        await login('trader@example.com', 'pwd');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(403);
        expect((err as ApiError).message).toBe('Same-origin request required.');
      }
    });

    it('throws NetworkError when network fails during login', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection reset'));

      await expect(login('trader@example.com', 'pwd')).rejects.toThrow(NetworkError);
    });
  });

  describe('register (POST /auth/register)', () => {
    it('sends email, password, and displayName with credentials: include', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => sampleUser,
      } as Response);
      globalThis.fetch = mockFetch;

      const user = await register('trader@example.com', 'correct horse battery staple', 'Trader One');

      expect(user).toEqual(sampleUser);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/auth/register');
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('include');
      expect(JSON.parse(options.body as string)).toEqual({
        email: 'trader@example.com',
        password: 'correct horse battery staple',
        displayName: 'Trader One',
      });
    });

    it('handles optional displayName when omitted', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => sampleUser,
      } as Response);
      globalThis.fetch = mockFetch;

      await register('trader@example.com', 'correct horse battery staple');

      const [, options] = mockFetch.mock.calls[0];
      const parsedBody = JSON.parse(options.body as string);
      expect(parsedBody).toEqual({
        email: 'trader@example.com',
        password: 'correct horse battery staple',
      });
      expect(parsedBody.displayName).toBeUndefined();
    });

    it('throws ApiError on HTTP 403 when registration is disabled', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ detail: 'Registration is disabled.' }),
      } as Response);

      await expect(register('trader@example.com', 'password123456')).rejects.toThrow(ApiError);

      try {
        await register('trader@example.com', 'password123456');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(403);
        expect((err as ApiError).message).toBe('Registration is disabled.');
      }
    });

    it('throws ApiError on HTTP 409 conflict when email already exists', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: async () => ({ detail: 'Unable to register with the supplied details.' }),
      } as Response);

      await expect(register('existing@example.com', 'password123456')).rejects.toThrow(ApiError);

      try {
        await register('existing@example.com', 'password123456');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(409);
        expect((err as ApiError).message).toBe('Unable to register with the supplied details.');
      }
    });

    it('throws ApiError on HTTP 422 when password is under 12 characters', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ detail: 'String should have at least 12 characters' }),
      } as Response);

      try {
        await register('trader@example.com', 'short');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(422);
      }
    });

    it('throws NetworkError when registration network call fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      await expect(register('trader@example.com', 'password123456')).rejects.toThrow(NetworkError);
    });
  });

  describe('logout (POST /auth/logout)', () => {
    it('sends x-csrf-token header and credentials: include when nse_csrf cookie exists', async () => {
      mockCookieStore = 'other=val; nse_csrf=valid-csrf-token-xyz; session_hint=1';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'logged_out' }),
      } as Response);
      globalThis.fetch = mockFetch;

      const result = await logout();

      expect(result).toEqual({ status: 'logged_out' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/auth/logout');
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('include');
      expect(options.headers).toMatchObject({
        'x-csrf-token': 'valid-csrf-token-xyz',
      });
    });

    it('handles missing CSRF cookie safely without sending a fabricated token', async () => {
      mockCookieStore = 'other=val; theme=dark'; // No nse_csrf cookie

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'logged_out' }),
      } as Response);
      globalThis.fetch = mockFetch;

      await logout();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers).toBeDefined();
      expect((options.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
    });

    it('throws ApiError with status 403 if backend rejects due to CSRF failure', async () => {
      mockCookieStore = '';

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ detail: 'CSRF validation failed.' }),
      } as Response);

      await expect(logout()).rejects.toThrow(ApiError);

      try {
        await logout();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(403);
        expect((err as ApiError).message).toBe('CSRF validation failed.');
      }
    });

    it('throws AuthenticationError if session was already expired (HTTP 401)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ detail: 'Authentication required.' }),
      } as Response);

      await expect(logout()).rejects.toThrow(AuthenticationError);
    });

    it('throws NetworkError when logout network call fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

      await expect(logout()).rejects.toThrow(NetworkError);
    });
  });
});
