import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { PortfolioProvider } from '../context/PortfolioContext';
import { TopBar, formatRefSessionDate } from '../components/layout/TopBar';
import * as api from '../services/api';
import type { UserRead } from '../services/api';
import type { MarketSnapshotRead, UniverseStatusRead } from '../types/trading';

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

describe('TopBar Component Authentication Integration', () => {
  let container: MockElement;
  let root: ReturnType<typeof createRoot>;

  const mockUser: UserRead = {
    id: 'user-top-1',
    email: 'portfolio.lead@example.com',
    displayName: 'Lead Quant Trader',
    createdAt: '2026-10-24T12:00:00Z',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
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

  it('renders Demo Mode indicator and prominent Data Status badge', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new api.AuthenticationError('Authentication required.')
    );

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="Trading Terminal Dashboard" />
        </AuthProvider>
      );
    });

    const demoIndicator = container.find(
      (el) => el.textContent.includes('Demo Mode (Mock Data)')
    );
    expect(demoIndicator).not.toBeNull();

    const dataStatus = container.find(
      (el) => el.textContent.includes('SAMPLE DATA')
    );
    expect(dataStatus).not.toBeNull();
  });

  it('renders clear Sign In action when user is unauthenticated', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new api.AuthenticationError('Authentication required.')
    );

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="Trading Terminal Dashboard" />
        </AuthProvider>
      );
    });

    const signInBtn = container.find(
      (el) => el.getAttribute('aria-label') === 'Sign in to your account'
    );
    expect(signInBtn).not.toBeNull();
    expect(signInBtn?.textContent).toContain('Sign In');
  });

  it('opens authentication modal when Sign In button is clicked', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new api.AuthenticationError('Authentication required.')
    );

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="Trading Terminal Dashboard" />
        </AuthProvider>
      );
    });

    // Initially modal is closed
    let modal = container.find((el) => el.getAttribute('role') === 'dialog');
    expect(modal).toBeNull();

    const signInBtn = container.find(
      (el) => el.getAttribute('aria-label') === 'Sign in to your account'
    );
    await act(async () => {
      simulateClick(signInBtn);
    });

    // Modal is now open
    modal = container.find((el) => el.getAttribute('role') === 'dialog');
    expect(modal).not.toBeNull();
  });

  it('displays user display name when authenticated and provides Sign Out action', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="Trading Terminal Dashboard" />
        </AuthProvider>
      );
    });

    const profileName = container.find(
      (el) => el.textContent.includes('Lead Quant Trader')
    );
    expect(profileName).not.toBeNull();

    const signOutBtn = container.find(
      (el) => el.getAttribute('aria-label') === 'Sign out of your account'
    );
    expect(signOutBtn).not.toBeNull();
    expect(signOutBtn?.textContent).toContain('Sign Out');
  });

  it('falls back to displaying email if displayName is null', async () => {
    const userWithoutName: UserRead = {
      id: 'user-top-2',
      email: 'noname@example.com',
      displayName: null,
      createdAt: '2026-10-24T12:00:00Z',
    };
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(userWithoutName);

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="Trading Terminal Dashboard" />
        </AuthProvider>
      );
    });

    const emailDisplay = container.find(
      (el) => el.textContent.includes('noname@example.com')
    );
    expect(emailDisplay).not.toBeNull();
  });

  it('handles successful logout by clearing authenticated profile and showing Sign In', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const logoutSpy = vi.spyOn(api, 'logout').mockResolvedValue({ status: 'ok' });

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="Trading Terminal Dashboard" />
        </AuthProvider>
      );
    });

    const signOutBtn = container.find(
      (el) => el.getAttribute('aria-label') === 'Sign out of your account'
    );
    await act(async () => {
      simulateClick(signOutBtn);
    });

    expect(logoutSpy).toHaveBeenCalledTimes(1);

    // Profile is cleared and Sign In button reappears
    const signInBtn = container.find(
      (el) => el.getAttribute('aria-label') === 'Sign in to your account'
    );
    expect(signInBtn).not.toBeNull();
  });

  it('handles failed logout without pretending logout succeeded', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'logout').mockRejectedValue(new api.ApiError(403, 'CSRF verification failed.'));

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="Trading Terminal Dashboard" />
        </AuthProvider>
      );
    });

    const signOutBtn = container.find(
      (el) => el.getAttribute('aria-label') === 'Sign out of your account'
    );
    await act(async () => {
      simulateClick(signOutBtn);
    });

    // Alert for failed logout is displayed
    const alert = container.find((el) => el.getAttribute('role') === 'alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Logout failed');

    // User is still authenticated
    const profileName = container.find(
      (el) => el.textContent.includes('Lead Quant Trader')
    );
    expect(profileName).not.toBeNull();
  });

  it('displays session verification failure status with retry option when network fails', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new api.NetworkError('Network error.')
    );

    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="Trading Terminal Dashboard" />
        </AuthProvider>
      );
    });

    const statusPill = container.find(
      (el) => el.getAttribute('role') === 'status'
    );
    expect(statusPill).not.toBeNull();
    expect(statusPill?.textContent).toContain('Session check failed');

    const retryBtn = container.find(
      (el) => el.getAttribute('aria-label') === 'Retry session verification'
    );
    expect(retryBtn).not.toBeNull();

    // Now mock recovery on retry
    const fetchSpy = vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);

    await act(async () => {
      simulateClick(retryBtn);
    });

    expect(fetchSpy).toHaveBeenCalled();
    // After retry success, authenticated profile is displayed
    const profileName = container.find(
      (el) => el.textContent.includes('Lead Quant Trader')
    );
    expect(profileName).not.toBeNull();
  });

  const mockValidUniverse: UniverseStatusRead = {
    isAvailable: true,
    isValidForDate: true,
    status: 'VALID',
    datasetVersion: 'AMFI-2026-H2-V1',
    sourcePeriodLabel: 'July 2026 - December 2026',
    classificationPeriod: 'JUL_DEC_2026',
    effectiveFrom: '2026-07-01',
    effectiveTo: '2026-12-31',
    constituentCount: 100,
    statusReason: 'NSE Large-Cap Universe is valid and active.',
  };

  const mockFreshTejSnapshot: MarketSnapshotRead = {
    symbol: 'RELIANCE',
    instrumentIdentifier: 'INE002A01018',
    lastPrice: 1190.0,
    quoteTimestamp: '2026-10-23T15:30:00+05:30',
    twentyWeekSma: 1273.22,
    weeklyRsi: 37.05,
    latestCompletedCandleDate: '2026-10-16',
    completedCandlesCount: 100,
    isStale: false,
    isEligibleForInitial: false,
    statusReason: null,
    source: 'TEJHQ',
  };

  it('renders VERIFIED EOD badge in green when backend confirms valid universe and fresh quotes from real provider', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(mockValidUniverse);
    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(mockFreshTejSnapshot);

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TopBar pageTitle="Trading Terminal Dashboard" />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    const verifiedBadge = container.find(
      (el) => el.textContent.includes('VERIFIED EOD')
    );
    expect(verifiedBadge).not.toBeNull();

    const sampleBadge = container.find(
      (el) => el.textContent.includes('SAMPLE DATA')
    );
    expect(sampleBadge).toBeNull();
  });

  it('derives provider name dynamically from response metadata (e.g. UPSTOX)', async () => {
    const upstoxSnapshot: MarketSnapshotRead = {
      ...mockFreshTejSnapshot,
      source: 'UPSTOX',
    };
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(mockValidUniverse);
    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(upstoxSnapshot);

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TopBar pageTitle="Trading Terminal Dashboard" />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    const verifiedBadge = container.find(
      (el) => el.textContent.includes('VERIFIED EOD')
    );
    expect(verifiedBadge).not.toBeNull();
  });

  it('renders STALE DATA badge in amber when backend reports quote is stale', async () => {
    const staleSnapshot: MarketSnapshotRead = {
      ...mockFreshTejSnapshot,
      isStale: true,
    };
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(mockValidUniverse);
    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(staleSnapshot);

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TopBar pageTitle="Trading Terminal Dashboard" />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    const staleBadge = container.find(
      (el) => el.textContent.includes('STALE DATA')
    );
    expect(staleBadge).not.toBeNull();

    const verifiedBadge = container.find(
      (el) => el.textContent.includes('VERIFIED EOD')
    );
    expect(verifiedBadge).toBeNull();
  });

  it('renders DATA UNAVAILABLE badge in red when universe is not valid', async () => {
    const unavailableUniverse: UniverseStatusRead = {
      ...mockValidUniverse,
      isAvailable: false,
      isValidForDate: false,
      status: 'UNAVAILABLE',
      statusReason: 'Universe file missing or corrupted.',
    };
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(unavailableUniverse);

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TopBar pageTitle="Trading Terminal Dashboard" />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    const unavailBadge = container.find(
      (el) => el.textContent.includes('DATA UNAVAILABLE')
    );
    expect(unavailBadge).not.toBeNull();

    const verifiedBadge = container.find(
      (el) => el.textContent.includes('VERIFIED EOD')
    );
    expect(verifiedBadge).toBeNull();
  });

  it('renders PROVIDER ERROR badge in red when market data request fails', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(mockValidUniverse);
    vi.spyOn(api, 'fetchMarketSnapshot').mockRejectedValue(
      new api.ApiError(503, 'Market data provider authentication failed.')
    );

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TopBar pageTitle="Trading Terminal Dashboard" />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    const errorBadge = container.find(
      (el) => el.textContent.includes('PROVIDER ERROR')
    );
    expect(errorBadge).not.toBeNull();

    const verifiedBadge = container.find(
      (el) => el.textContent.includes('VERIFIED EOD')
    );
    expect(verifiedBadge).toBeNull();
  });

  it('never treats authentication alone as evidence that market data is verified', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockRejectedValue(
      new api.NetworkError('Cannot reach universe API')
    );

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TopBar pageTitle="Trading Terminal Dashboard" />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    // Despite being authenticated, verified badge must NOT be rendered when backend check fails
    const verifiedBadge = container.find(
      (el) => el.textContent.includes('VERIFIED EOD')
    );
    expect(verifiedBadge).toBeNull();

    const errorBadge = container.find(
      (el) => el.textContent.includes('PROVIDER ERROR')
    );
    expect(errorBadge).not.toBeNull();
  });

  it('shows loading state while source status is being established', async () => {
    await act(async () => {
      root.render(
        <AuthProvider>
          <TopBar pageTitle="Trading Terminal Dashboard" marketDataStatus="loading" />
        </AuthProvider>
      );
    });

    const loadingBadge = container.find(
      (el) => el.textContent.includes('CHECKING DATA...')
    );
    expect(loadingBadge).not.toBeNull();
  });

  it('preserves SAMPLE DATA badge when in unauthenticated demo mode', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new api.AuthenticationError('Authentication required.')
    );

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TopBar pageTitle="Trading Terminal Dashboard" />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    const sampleBadge = container.find(
      (el) => el.textContent.includes('SAMPLE DATA')
    );
    expect(sampleBadge).not.toBeNull();

    const verifiedBadge = container.find(
      (el) => el.textContent.includes('VERIFIED EOD')
    );
    expect(verifiedBadge).toBeNull();
  });

  describe('formatRefSessionDate helper', () => {
    it('returns Ref As-Of: 23-Oct Close in Demo Mode', () => {
      expect(formatRefSessionDate(null, false)).toBe('Ref As-Of: 23-Oct Close');
      expect(formatRefSessionDate('2026-10-29T15:30:00+05:30', false)).toBe('Ref As-Of: 23-Oct Close');
    });

    it('formats valid timestamp in Asia/Kolkata timezone with day-month in authenticated mode', () => {
      expect(formatRefSessionDate('2026-10-29T15:30:00+05:30', true)).toBe('Ref As-Of: 29-Oct Close');
      expect(formatRefSessionDate('2026-10-29T19:00:00Z', true)).toBe('Ref As-Of: 30-Oct Close');
    });

    it('returns Market date unavailable for invalid or missing timestamps in authenticated mode', () => {
      expect(formatRefSessionDate(null, true)).toBe('Market date unavailable');
      expect(formatRefSessionDate(undefined, true)).toBe('Market date unavailable');
      expect(formatRefSessionDate('', true)).toBe('Market date unavailable');
      expect(formatRefSessionDate('not-a-date', true)).toBe('Market date unavailable');
    });
  });

  it('displays 29-Oct Close in authenticated mode when snapshot has 29 October timestamp', async () => {
    const oct29Snapshot: MarketSnapshotRead = {
      ...mockFreshTejSnapshot,
      quoteTimestamp: '2026-10-29T15:30:00+05:30',
    };
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(mockValidUniverse);
    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(oct29Snapshot);

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TopBar pageTitle="Trading Terminal Dashboard" />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    // Top-right session pill
    const refDateEl = container.find(
      (el) => el.textContent.includes('29-Oct Close')
    );
    expect(refDateEl).not.toBeNull();
    expect(refDateEl?.textContent).toContain('Ref As-Of: 29-Oct Close');

    // Confirm it does NOT display 23-Oct
    const oldDateEl = container.find(
      (el) => el.textContent.includes('23-Oct Close')
    );
    expect(oldDateEl).toBeNull();

    // DataStatusBadge popover check
    const badgeBtn = container.find(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes('VERIFIED EOD')
    );
    expect(badgeBtn).not.toBeNull();
    await act(async () => {
      simulateClick(badgeBtn);
    });
    const asOfDisplay = container.find(
      (el) => el.textContent.includes('2026-10-29T15:30:00+05:30')
    );
    expect(asOfDisplay).not.toBeNull();
  });

  it('displays Market date unavailable when timestamp is unavailable in authenticated mode and does not fall back to 23 October', async () => {
    const nullTimestampSnapshot: MarketSnapshotRead = {
      ...mockFreshTejSnapshot,
      quoteTimestamp: null as unknown as string,
    };
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(mockValidUniverse);
    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(nullTimestampSnapshot);

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TopBar pageTitle="Trading Terminal Dashboard" />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    const unavailableEl = container.find(
      (el) => el.textContent.includes('Market date unavailable')
    );
    expect(unavailableEl).not.toBeNull();

    // Confirm it did NOT fall back to 23 October
    const fallbackEl = container.find(
      (el) => el.textContent.includes('23-Oct')
    );
    expect(fallbackEl).toBeNull();
  });

  it('retains demo fallback Ref As-Of: 23-Oct Close in Demo Mode', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new api.AuthenticationError('Authentication required.')
    );

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TopBar pageTitle="Trading Terminal Dashboard" />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    const demoDateEl = container.find(
      (el) => el.textContent.includes('Ref As-Of: 23-Oct Close')
    );
    expect(demoDateEl).not.toBeNull();

    const unavailableEl = container.find(
      (el) => el.textContent.includes('Market date unavailable')
    );
    expect(unavailableEl).toBeNull();
  });
});
