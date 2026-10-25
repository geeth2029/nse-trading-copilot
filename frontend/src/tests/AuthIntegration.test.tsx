import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { TopBar } from '../components/layout/TopBar';

// --- Minimal Node DOM Mock for React 19 ---
class MockNode {}
class MockTextNode extends MockNode {
  nodeType = 3;
  nodeName = '#text';
  textContent: string;
  constructor(text: string = '') {
    super();
    this.textContent = text;
  }
}

class MockElement extends MockNode {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  ownerDocument = globalThis.document;
  style: Record<string, string> = {};
  childNodes: (MockElement | MockTextNode)[] = [];
  attributes: Record<string, string> = {};
  value: string = '';
  eventListeners: Record<string, ((e: unknown) => void)[]> = {};

  constructor(tag = 'div') {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
  }

  focus() {}
  blur() {}

  setAttribute(name: string, val: string) {
    this.attributes[name] = String(val);
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string) {
    return name in this.attributes;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  addEventListener(event: string, listener: (e: unknown) => void) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(listener);
  }

  removeEventListener(event: string, listener: (e: unknown) => void) {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter((l) => l !== listener);
  }

  dispatchEvent(event: { type: string; target?: unknown }): boolean {
    event.target = this;
    const listeners = this.eventListeners[event.type] || [];
    for (const listener of listeners) {
      listener(event);
    }
    return true;
  }

  appendChild(child: MockElement | MockTextNode) {
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: MockElement | MockTextNode) {
    this.childNodes = this.childNodes.filter((c) => c !== child);
    return child;
  }

  insertBefore(child: MockElement | MockTextNode) {
    this.childNodes.push(child);
    return child;
  }

  get textContent(): string {
    return this.childNodes
      .map((c) => ('textContent' in c ? c.textContent : ''))
      .join('');
  }

  set textContent(text: string) {
    this.childNodes = [new MockTextNode(text)];
  }

  find(predicate: (el: MockElement) => boolean): MockElement | null {
    if (predicate(this)) return this;
    for (const child of this.childNodes) {
      if (child.nodeType === 1) {
        const found = (child as MockElement).find(predicate);
        if (found) return found;
      }
    }
    return null;
  }

  findAll(predicate: (el: MockElement) => boolean): MockElement[] {
    const results: MockElement[] = [];
    if (predicate(this)) results.push(this);
    for (const child of this.childNodes) {
      if (child.nodeType === 1) {
        results.push(...(child as MockElement).findAll(predicate));
      }
    }
    return results;
  }
}

const windowListeners: Record<string, ((e: unknown) => void)[]> = {};

function setupMockDom() {
  globalThis.window = globalThis as unknown as Window & typeof globalThis;
  // @ts-expect-error test DOM listeners on window
  globalThis.addEventListener = (event: string, listener: (e: unknown) => void) => {
    if (!windowListeners[event]) windowListeners[event] = [];
    windowListeners[event].push(listener);
  };
  // @ts-expect-error test DOM listeners on window
  globalThis.removeEventListener = (event: string, listener: (e: unknown) => void) => {
    if (!windowListeners[event]) return;
    windowListeners[event] = windowListeners[event].filter((l) => l !== listener);
  };
  globalThis.dispatchEvent = (event: Event) => {
    const listeners = windowListeners[event.type] || [];
    for (const listener of listeners) listener(event);
    return true;
  };
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
    createElementNS: (_ns: string, tag: string) => new MockElement(tag),
    createTextNode: (text: string) => new MockTextNode(text),
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
  } as unknown as Document;
}

setupMockDom();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getProps(el: MockElement | null): Record<string, any> {
  if (!el) throw new Error('Element not found');
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactProps$')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (el as unknown as Record<string, any>)[key];
    }
  }
  throw new Error('React internal props not found on element');
}

function simulateClick(el: MockElement | null) {
  const props = getProps(el);
  if (props.onClick) {
    props.onClick({ target: el, currentTarget: el, preventDefault: () => {} });
  }
}

async function simulateSubmit(el: MockElement | null) {
  const props = getProps(el);
  if (props.onSubmit) {
    await props.onSubmit({ preventDefault: () => {} });
  }
}

async function changeInput(el: MockElement | null, value: string) {
  const props = getProps(el);
  if (props.onChange) {
    await act(async () => {
      props.onChange({ target: { value } });
    });
  }
}

describe('Frontend Auth & Backend HTTP Integration Tests', () => {
  const originalFetch = globalThis.fetch;
  let mockCookieStore = '';
  let container: MockElement;
  let root: ReturnType<typeof createRoot>;

  const mockUserPayload = {
    id: 'usr_f17a9c8b',
    email: 'trader.quant@nse.in',
    displayName: 'Senior Momentum Trader',
    createdAt: '2026-10-24T09:15:00Z',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCookieStore = '';

    // Mock document.cookie
    Object.defineProperty(globalThis.document, 'cookie', {
      get() {
        return mockCookieStore;
      },
      set(val: string) {
        mockCookieStore = val;
      },
      configurable: true,
    });

    container = new MockElement('div');
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('session restoration: 200 on /auth/me automatically restores user profile into UI', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/auth/me') {
        return {
          ok: true,
          status: 200,
          json: async () => mockUserPayload,
        } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="NSE Live Order Book" />
        </AuthProvider>
      );
    });

    // Verify GET /auth/me was called with credentials: 'include'
    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/me',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
      })
    );

    // Profile display should show displayName and Sign Out button
    const profile = container.find((el) => el.textContent.includes('Senior Momentum Trader'));
    expect(profile).not.toBeNull();

    const signOutBtn = container.find((el) => el.getAttribute('aria-label') === 'Sign out of your account');
    expect(signOutBtn).not.toBeNull();

    // Verify no session failure banner appears
    const statusPill = container.find((el) => el.getAttribute('role') === 'status');
    expect(statusPill).toBeNull();
  });

  it('session restoration: 401 unauthenticated leaves UI in clean guest state without error alert', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/auth/me') {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ detail: 'Authentication required.' }),
        } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="NSE Live Order Book" />
        </AuthProvider>
      );
    });

    // Sign In button should be present
    const signInBtn = container.find((el) => el.getAttribute('aria-label') === 'Sign in to your account');
    expect(signInBtn).not.toBeNull();

    // No warning banner should be displayed for normal unauthenticated 401
    const statusPill = container.find((el) => el.getAttribute('role') === 'status');
    expect(statusPill).toBeNull();

    // Demo indicators must remain visible
    expect(container.find((el) => el.textContent.includes('Demo Mode (Mock Data)'))).not.toBeNull();
    expect(container.find((el) => el.textContent.includes('SAMPLE DATA'))).not.toBeNull();
  });

  it('session restoration: network error shows retry option and recovers on retry', async () => {
    let networkFailed = true;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/auth/me') {
        if (networkFailed) {
          throw new TypeError('Failed to fetch (offline)');
        }
        return {
          ok: true,
          status: 200,
          json: async () => mockUserPayload,
        } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="NSE Live Order Book" />
        </AuthProvider>
      );
    });

    // Verification failed status should be visible
    const statusPill = container.find((el) => el.getAttribute('role') === 'status');
    expect(statusPill).not.toBeNull();
    expect(statusPill?.textContent).toContain('Session check failed');

    const retryBtn = container.find((el) => el.getAttribute('aria-label') === 'Retry session verification');
    expect(retryBtn).not.toBeNull();

    // Now simulate network recovery and retry
    networkFailed = false;
    await act(async () => {
      simulateClick(retryBtn);
    });

    // Profile should now be restored
    const profile = container.find((el) => el.textContent.includes('Senior Momentum Trader'));
    expect(profile).not.toBeNull();

    // Session check warning should be gone
    expect(container.find((el) => el.getAttribute('role') === 'status')).toBeNull();
  });

  it('login integration: sends expected JSON fields and only updates state on 200 response', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
      if (url === '/auth/me') {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ detail: 'Authentication required.' }),
        } as Response;
      }
      if (url === '/auth/login') {
        const body = JSON.parse(options.body as string);
        if (body.email === 'trader.quant@nse.in' && body.password === 'valid_secret_pass123') {
          return {
            ok: true,
            status: 200,
            json: async () => mockUserPayload,
          } as Response;
        }
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ detail: 'Invalid email or password.' }),
        } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="NSE Live Order Book" />
        </AuthProvider>
      );
    });

    // 1. Open AuthModal
    const signInBtn = container.find((el) => el.getAttribute('aria-label') === 'Sign in to your account');
    await act(async () => {
      simulateClick(signInBtn);
    });

    // Modal is open
    let modal = container.find((el) => el.getAttribute('role') === 'dialog');
    expect(modal).not.toBeNull();

    const emailInput = container.find((el) => el.getAttribute('id') === 'auth-email-input');
    const passwordInput = container.find((el) => el.getAttribute('id') === 'auth-password-input');
    const form = container.find((el) => el.tagName === 'FORM');

    // 2. Submit INVALID credentials first
    await changeInput(emailInput, 'trader.quant@nse.in');
    await changeInput(passwordInput, 'wrong_pass');
    await act(async () => {
      await simulateSubmit(form);
    });

    // Modal should show error banner and remain open
    const alert = container.find((el) => el.getAttribute('role') === 'alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Invalid email or password');

    // State is still unauthenticated
    expect(container.find((el) => el.getAttribute('aria-label') === 'Sign out of your account')).toBeNull();

    // 3. Submit VALID credentials
    await changeInput(passwordInput, 'valid_secret_pass123');
    await act(async () => {
      await simulateSubmit(form);
    });

    // Verify /auth/login was called with expected JSON body
    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          email: 'trader.quant@nse.in',
          password: 'valid_secret_pass123',
        }),
      })
    );

    // Modal should now be closed and user state updated
    modal = container.find((el) => el.getAttribute('role') === 'dialog');
    expect(modal).toBeNull();

    // Profile name should now appear in TopBar
    const profile = container.find((el) => el.textContent.includes('Senior Momentum Trader'));
    expect(profile).not.toBeNull();
  });

  it('logout integration: sends nse_csrf token in x-csrf-token and clears state on success', async () => {
    // Start with authenticated session and valid CSRF cookie
    mockCookieStore = 'theme=dark; nse_csrf=csrf_secret_token_123; tracking=0';

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/auth/me') {
        return {
          ok: true,
          status: 200,
          json: async () => mockUserPayload,
        } as Response;
      }
      if (url === '/auth/logout') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'logged_out' }),
        } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="NSE Live Order Book" />
        </AuthProvider>
      );
    });

    // Click Sign Out
    const signOutBtn = container.find((el) => el.getAttribute('aria-label') === 'Sign out of your account');
    expect(signOutBtn).not.toBeNull();

    await act(async () => {
      simulateClick(signOutBtn);
    });

    // Verify /auth/logout was called with x-csrf-token header matching the nse_csrf cookie
    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({
          'x-csrf-token': 'csrf_secret_token_123',
        }),
      })
    );

    // After successful logout, profile is cleared and Sign In button reappears
    expect(container.find((el) => el.textContent.includes('Senior Momentum Trader'))).toBeNull();
    expect(container.find((el) => el.getAttribute('aria-label') === 'Sign in to your account')).not.toBeNull();
  });

  it('logout failure: preserves authenticated state and shows error when backend rejects', async () => {
    mockCookieStore = 'nse_csrf=csrf_bad_token';

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/auth/me') {
        return {
          ok: true,
          status: 200,
          json: async () => mockUserPayload,
        } as Response;
      }
      if (url === '/auth/logout') {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: async () => ({ detail: 'CSRF validation failed.' }),
        } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="NSE Live Order Book" />
        </AuthProvider>
      );
    });

    const signOutBtn = container.find((el) => el.getAttribute('aria-label') === 'Sign out of your account');
    await act(async () => {
      simulateClick(signOutBtn);
    });

    // Logout failed: Profile MUST still be displayed and alert shown
    expect(container.find((el) => el.textContent.includes('Senior Momentum Trader'))).not.toBeNull();
    const alert = container.find((el) => el.getAttribute('role') === 'alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Logout failed');
  });

  it('registration disabled: UI handles 403 Forbidden with clear disabled alert', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/auth/me') {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ detail: 'Authentication required.' }),
        } as Response;
      }
      if (url === '/auth/register') {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: async () => ({ detail: 'Registration is disabled.' }),
        } as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    globalThis.fetch = fetchMock;

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="NSE Live Order Book" />
        </AuthProvider>
      );
    });

    // Open AuthModal
    const signInBtn = container.find((el) => el.getAttribute('aria-label') === 'Sign in to your account');
    await act(async () => {
      simulateClick(signInBtn);
    });

    // Switch to Register tab
    const registerTab = container.find((el) => el.getAttribute('role') === 'tab' && el.textContent === 'Register');
    await act(async () => {
      simulateClick(registerTab);
    });

    const emailInput = container.find((el) => el.getAttribute('id') === 'auth-email-input');
    const passwordInput = container.find((el) => el.getAttribute('id') === 'auth-password-input');
    const form = container.find((el) => el.tagName === 'FORM');

    await changeInput(emailInput, 'newtrader@nse.in');
    await changeInput(passwordInput, 'long_secure_pass123');

    await act(async () => {
      await simulateSubmit(form);
    });

    // Should display registration disabled alert banner
    const alert = container.find((el) => el.getAttribute('role') === 'alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('New user registration is currently disabled');

    // User is not authenticated
    expect(container.find((el) => el.getAttribute('aria-label') === 'Sign out of your account')).toBeNull();
  });
});
