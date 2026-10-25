import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider, useAuth, type AuthContextType } from '../context/AuthContext';
import * as api from '../services/api';
import { AuthenticationError, NetworkError, ApiError, type UserRead } from '../services/api';

// --- Minimal DOM Mock for React 19 Client Rendering in Node ---
class MockNode {}
class MockElement extends MockNode {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  ownerDocument = globalThis.document;
  style = {};
  childNodes: unknown[] = [];

  constructor(tag = 'div') {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
  }

  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  appendChild(child: unknown) {
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: unknown) {
    return child;
  }
  insertBefore(child: unknown) {
    this.childNodes.push(child);
    return child;
  }
}

function setupMockDom() {
  globalThis.window = globalThis as unknown as Window & typeof globalThis;
  // @ts-expect-error test act flag
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // @ts-expect-error test DOM constructor stubs
  globalThis.Node = MockNode;
  // @ts-expect-error test DOM constructor stubs
  globalThis.Element = MockElement;
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLElement = MockElement;
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLIFrameElement = class extends MockElement {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLInputElement = class extends MockElement {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLTextAreaElement = class extends MockElement {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLSelectElement = class extends MockElement {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLDocument = function () {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.Document = function () {};

  globalThis.document = {
    nodeType: 9,
    nodeName: '#document',
    ownerDocument: null,
    documentElement: new MockElement('html'),
    createElement: (tag: string) => new MockElement(tag),
    createTextNode: () => ({ nodeType: 3, nodeName: '#text' }),
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
  } as unknown as Document;
}

setupMockDom();

describe('AuthContext (context/AuthContext.tsx)', () => {
  let container: MockElement;
  let root: ReturnType<typeof createRoot>;
  let latestContext: AuthContextType | null = null;

  const mockUser: UserRead = {
    id: 'user-101',
    email: 'trader@example.com',
    displayName: 'Lead Trader',
    createdAt: '2026-10-24T12:00:00Z',
  };

  function TestConsumer() {
    const auth = useAuth();
    useEffect(() => {
      latestContext = auth;
    });
    return null;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    latestContext = null;
    container = new MockElement('div');
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
  });

  async function renderProvider() {
    await act(async () => {
      root.render(
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      );
    });
  }

  it('initial session verification succeeds and populates user state', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);

    await renderProvider();

    expect(latestContext).not.toBeNull();
    expect(latestContext!.isLoading).toBe(false);
    expect(latestContext!.isAuthenticated).toBe(true);
    expect(latestContext!.user).toEqual(mockUser);
    expect(latestContext!.authError).toBeNull();
  });

  it('HTTP 401 produces an unauthenticated state without displaying an error', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new AuthenticationError('Authentication required.')
    );

    await renderProvider();

    expect(latestContext).not.toBeNull();
    expect(latestContext!.isLoading).toBe(false);
    expect(latestContext!.isAuthenticated).toBe(false);
    expect(latestContext!.user).toBeNull();
    // 401 is a normal guest session; not a displayed error
    expect(latestContext!.authError).toBeNull();
  });

  it('network failure produces an unknown/verification-failed state, not a confirmed logged-out state', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new NetworkError('Network request failed: Failed to fetch')
    );

    await renderProvider();

    expect(latestContext).not.toBeNull();
    expect(latestContext!.isLoading).toBe(false);
    expect(latestContext!.isAuthenticated).toBe(false);
    expect(latestContext!.user).toBeNull();
    expect(latestContext!.authError).toBe(
      'Session verification failed: Unable to connect to the authentication service.'
    );

    // clearAuthError clears the failure message
    act(() => {
      latestContext!.clearAuthError();
    });
    expect(latestContext!.authError).toBeNull();
  });

  it('provider handles initial loading state while verification is in-flight', async () => {
    let resolveVerification!: (user: UserRead) => void;
    const verificationPromise = new Promise<UserRead>((resolve) => {
      resolveVerification = resolve;
    });
    vi.spyOn(api, 'fetchCurrentUser').mockReturnValue(verificationPromise);

    let capturedLoadingState: boolean | undefined;
    function LoadingInspector() {
      const { isLoading } = useAuth();
      useEffect(() => {
        capturedLoadingState = isLoading;
      }, [isLoading]);
      return null;
    }

    await act(async () => {
      root.render(
        <AuthProvider>
          <LoadingInspector />
          <TestConsumer />
        </AuthProvider>
      );
    });

    // In-flight state: isLoading is true
    expect(capturedLoadingState).toBe(true);
    expect(latestContext!.isLoading).toBe(true);
    expect(latestContext!.user).toBeNull();

    // Resolve in-flight verification
    await act(async () => {
      resolveVerification(mockUser);
    });

    expect(latestContext!.isLoading).toBe(false);
    expect(latestContext!.isAuthenticated).toBe(true);
    expect(latestContext!.user).toEqual(mockUser);
  });

  it('successful login updates the user and authentication state', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new AuthenticationError('Authentication required.')
    );
    vi.spyOn(api, 'login').mockResolvedValue(mockUser);

    await renderProvider();
    expect(latestContext!.isAuthenticated).toBe(false);

    let result!: { success: boolean; error?: string };
    await act(async () => {
      result = await latestContext!.login('trader@example.com', 'correct horse battery staple');
    });

    expect(result.success).toBe(true);
    expect(latestContext!.isAuthenticated).toBe(true);
    expect(latestContext!.user).toEqual(mockUser);
    expect(latestContext!.authError).toBeNull();
  });

  it('failed login exposes an error without authenticating the user', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new AuthenticationError('Authentication required.')
    );
    vi.spyOn(api, 'login').mockRejectedValue(new AuthenticationError('Invalid email or password.'));

    await renderProvider();

    let result!: { success: boolean; error?: string };
    await act(async () => {
      result = await latestContext!.login('trader@example.com', 'wrongpassword');
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid email or password.');
    expect(latestContext!.isAuthenticated).toBe(false);
    expect(latestContext!.user).toBeNull();
    expect(latestContext!.authError).toBe('Invalid email or password.');
  });

  it('successful registration updates the user and authentication state', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new AuthenticationError('Authentication required.')
    );
    vi.spyOn(api, 'register').mockResolvedValue(mockUser);

    await renderProvider();

    let result!: { success: boolean; error?: string };
    await act(async () => {
      result = await latestContext!.register(
        'new@example.com',
        'password123456',
        'New Trader'
      );
    });

    expect(result.success).toBe(true);
    expect(latestContext!.isAuthenticated).toBe(true);
    expect(latestContext!.user).toEqual(mockUser);
    expect(latestContext!.authError).toBeNull();
  });

  it('failed registration exposes an error without authenticating', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new AuthenticationError('Authentication required.')
    );
    vi.spyOn(api, 'register').mockRejectedValue(new ApiError(403, 'Registration is disabled.'));

    await renderProvider();

    let result!: { success: boolean; error?: string };
    await act(async () => {
      result = await latestContext!.register('new@example.com', 'password123456');
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Registration is disabled.');
    expect(latestContext!.isAuthenticated).toBe(false);
    expect(latestContext!.user).toBeNull();
    expect(latestContext!.authError).toBe('Registration is disabled.');
  });

  it('successful logout clears the user and authentication state', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'logout').mockResolvedValue({ status: 'logged_out' });

    await renderProvider();
    expect(latestContext!.isAuthenticated).toBe(true);

    let result!: { success: boolean; error?: string };
    await act(async () => {
      result = await latestContext!.logout();
    });

    expect(result.success).toBe(true);
    expect(latestContext!.isAuthenticated).toBe(false);
    expect(latestContext!.user).toBeNull();
    expect(latestContext!.authError).toBeNull();
  });

  it('failed logout does not pretend logout succeeded and preserves safe state', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'logout').mockRejectedValue(new ApiError(403, 'CSRF validation failed.'));

    await renderProvider();
    expect(latestContext!.isAuthenticated).toBe(true);

    let result!: { success: boolean; error?: string };
    await act(async () => {
      result = await latestContext!.logout();
    });

    // Logout failed: must NOT pretend user is logged out!
    expect(result.success).toBe(false);
    expect(result.error).toBe('CSRF validation failed.');
    expect(latestContext!.isAuthenticated).toBe(true);
    expect(latestContext!.user).toEqual(mockUser);
    expect(latestContext!.authError).toBe('CSRF validation failed.');
  });

  it('throws an error when useAuth is called outside an AuthProvider', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(async () => {
        await act(async () => {
          root.render(<TestConsumer />);
        });
      }).rejects.toThrow('useAuth must be used within an AuthProvider');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
