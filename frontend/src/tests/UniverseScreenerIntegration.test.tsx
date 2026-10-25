import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { PortfolioProvider, PortfolioContext, usePortfolio, type PortfolioContextType } from '../context/PortfolioContext';
import { ScreenerView } from '../features/screener/ScreenerView';
import { Sidebar } from '../components/layout/Sidebar';
import * as api from '../services/api';
import {
  ApiError,
  AuthenticationError,
  type UserRead,
  type UniverseStatusRead,
  type UniverseScreenResponse,
  type ConstituentScreenResultRead,
} from '../services/api';
import { SAMPLE_NSE_STOCKS } from '../data/mockStocks';

// --- Minimal DOM Mock for React 19 in Node ---
class MockNode {
  parentElement: MockElement | null = null;
}
class MockTextNode extends MockNode {
  nodeType = 3;
  nodeName = '#text';
  textContent: string;
  constructor(text = '') {
    super();
    this.textContent = text;
  }
  get nodeValue(): string {
    return this.textContent;
  }
  set nodeValue(val: string) {
    this.textContent = String(val);
  }
  get data(): string {
    return this.textContent;
  }
  set data(val: string) {
    this.textContent = String(val);
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
  parentElement: MockElement | null = null;

  constructor(tag = 'div') {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
  }

  focus() {}
  blur() {}

  get id() {
    return this.attributes['id'] || '';
  }
  set id(val: string) {
    this.attributes['id'] = String(val);
  }

  get type() {
    return this.attributes['type'] || '';
  }
  set type(val: string) {
    this.attributes['type'] = String(val);
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }
  set disabled(val: boolean) {
    if (val) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  get checked() {
    return this.hasAttribute('checked');
  }
  set checked(val: boolean) {
    if (val) this.setAttribute('checked', '');
    else this.removeAttribute('checked');
  }

  setAttribute(name: string, val: string) {
    this.attributes[name] = String(val);
  }

  getAttribute(name: string) {
    if (name === 'type' && this.attributes['type']) return this.attributes['type'];
    if (name === 'id' && this.attributes['id']) return this.attributes['id'];
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string) {
    return name in this.attributes;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  appendChild<T extends MockElement | MockTextNode>(child: T): T {
    child.parentElement = this as unknown as MockElement;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends MockElement | MockTextNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentElement = null;
    }
    return child;
  }

  insertBefore<T extends MockElement | MockTextNode>(newNode: T, referenceNode: MockElement | MockTextNode | null): T {
    if (!referenceNode) {
      return this.appendChild(newNode);
    }
    const idx = this.childNodes.indexOf(referenceNode);
    if (idx !== -1) {
      newNode.parentElement = this as unknown as MockElement;
      this.childNodes.splice(idx, 0, newNode);
    } else {
      this.appendChild(newNode);
    }
    return newNode;
  }

  addEventListener(event: string, handler: (e: unknown) => void) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(handler);
  }

  removeEventListener(event: string, handler: (e: unknown) => void) {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter((h) => h !== handler);
  }

  dispatchEvent(event: { type: string }): boolean {
    const handlers = this.eventListeners[event.type] || [];
    for (const h of handlers) {
      h(event);
    }
    return true;
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(val: string) {
    this.childNodes = [new MockTextNode(val)];
  }

  get options(): MockElement[] {
    const opts: MockElement[] = [];
    this.findAll('option', opts);
    return opts;
  }

  querySelector(selector: string): MockElement | null {
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      return this.find((el) => el.id === id);
    }
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return this.find((el) => {
        const classAttr = el.getAttribute('class') || '';
        return classAttr.split(/\s+/).includes(cls);
      });
    }
    return this.find((el) => el.tagName.toLowerCase() === selector.toLowerCase());
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    this.findAll(selector, results);
    return results;
  }

  private find(predicate: (el: MockElement) => boolean): MockElement | null {
    for (const child of this.childNodes) {
      if (child instanceof MockElement) {
        if (predicate(child)) return child;
        const res = child.find(predicate);
        if (res) return res;
      }
    }
    return null;
  }

  private findAll(selector: string, results: MockElement[]) {
    for (const child of this.childNodes) {
      if (child instanceof MockElement) {
        if (selector.startsWith('#')) {
          if (child.id === selector.slice(1)) results.push(child);
        } else if (selector.startsWith('.')) {
          const classAttr = child.getAttribute('class') || '';
          if (classAttr.split(/\s+/).includes(selector.slice(1))) results.push(child);
        } else if (child.tagName.toLowerCase() === selector.toLowerCase()) {
          results.push(child);
        }
        child.findAll(selector, results);
      }
    }
  }
}

function setupMockDom() {
  globalThis.window = globalThis as unknown as Window & typeof globalThis;
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
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
    body: new MockElement('body'),
    createElement: (tag: string) => new MockElement(tag),
    createElementNS: (_ns: string, tag: string) => new MockElement(tag),
    createTextNode: (text: string) => new MockTextNode(text),
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
    cookie: '',
  } as unknown as Document;
}

setupMockDom();

// Helper to access React synthetic event props directly
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
  if (!el) throw new Error('Element not found');
  const props = getProps(el);
  if (props.onClick) {
    props.onClick({ target: el, currentTarget: el, preventDefault: () => {} });
  } else {
    let curr: MockElement | null = el;
    while (curr) {
      if (curr.tagName === 'FORM') {
        const formProps = getProps(curr);
        if (formProps.onSubmit) {
          formProps.onSubmit({ target: curr, currentTarget: curr, preventDefault: () => {} });
        }
        break;
      }
      curr = curr.parentElement;
    }
  }
}


describe('Phase 5D: Authenticated Large-Cap Universe Screener Integration', () => {
  let container: MockElement;
  let root: ReturnType<typeof createRoot>;
  let latestPortfolio: PortfolioContextType | null = null;

  function TestConsumer() {
    const portfolio = usePortfolio();
    useEffect(() => {
      latestPortfolio = portfolio;
    });
    return null;
  }

  const mockUser: UserRead = {
    id: 'user-phase5d',
    email: 'screener-tester@example.com',
    displayName: 'Phase 5D Tester',
    createdAt: '2026-10-25T10:00:00Z',
  };

  const validUniverseStatus: UniverseStatusRead = {
    isAvailable: true,
    isValidForDate: true,
    status: 'VALID',
    datasetVersion: 'amfi-2026-h2-v1',
    sourcePeriodLabel: 'July - December 2026',
    classificationPeriod: '2026-H2',
    effectiveFrom: '2026-07-01',
    effectiveTo: '2026-12-31',
    constituentCount: 100,
    statusReason: 'Universe active and verified against sidecar manifest SHA-256.',
  };

  const unavailableUniverseStatus: UniverseStatusRead = {
    isAvailable: false,
    isValidForDate: false,
    status: 'UNAVAILABLE',
    datasetVersion: null,
    sourcePeriodLabel: null,
    classificationPeriod: null,
    effectiveFrom: null,
    effectiveTo: null,
    constituentCount: 0,
    statusReason: 'Large-cap universe artifact not found on server.',
  };

  const expiredUniverseStatus: UniverseStatusRead = {
    isAvailable: true,
    isValidForDate: false,
    status: 'EXPIRED',
    datasetVersion: 'amfi-2026-h1-v1',
    sourcePeriodLabel: 'January - June 2026',
    classificationPeriod: '2026-H1',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-06-30',
    constituentCount: 100,
    statusReason: 'Universe classification expired on 2026-06-30.',
  };

  const invalidUniverseStatus: UniverseStatusRead = {
    isAvailable: true,
    isValidForDate: false,
    status: 'INVALID',
    datasetVersion: 'amfi-2026-h2-v1',
    sourcePeriodLabel: 'July - December 2026',
    classificationPeriod: '2026-H2',
    effectiveFrom: '2026-07-01',
    effectiveTo: '2026-12-31',
    constituentCount: 100,
    statusReason: 'Universe artifact checksum mismatch with sidecar manifest.',
  };

  const notYetActiveUniverseStatus: UniverseStatusRead = {
    isAvailable: true,
    isValidForDate: false,
    status: 'NOT_YET_ACTIVE',
    datasetVersion: 'amfi-2027-h1-v1',
    sourcePeriodLabel: 'January - June 2027',
    classificationPeriod: '2027-H1',
    effectiveFrom: '2027-01-01',
    effectiveTo: '2027-06-30',
    constituentCount: 100,
    statusReason: 'Classification becomes effective on 2027-01-01.',
  };

  // Generate 100 synthetic constituents for testing
  const generateSynthetic100ScreenResponse = (): UniverseScreenResponse => {
    const results: ConstituentScreenResultRead[] = [];
    for (let i = 1; i <= 100; i++) {
      const isQualified = i <= 25; // 25 qualified
      const isStale = i === 26; // 1 stale
      const isInsufficient = i === 27; // 1 insufficient history
      const isNoQuote = i === 28; // 1 quote unavailable

      let diagStatus = 'NOT_QUALIFIED';
      let diagReason: string | null = 'Weekly RSI 48.5 <= 60.0 threshold';
      let rsi: number | null = 48.5;
      let sma: number | null = 1000 + i * 10;
      let price: number | null = 1050 + i * 10;

      if (isQualified) {
        diagStatus = 'QUALIFIED';
        diagReason = 'Qualified: Weekly RSI > 60';
        rsi = 65.5 + (i % 5);
      } else if (isStale) {
        diagStatus = 'STALE_QUOTE';
        diagReason = 'Reference quote timestamp is older than permitted threshold';
        rsi = 64.0;
      } else if (isInsufficient) {
        diagStatus = 'INSUFFICIENT_HISTORY';
        diagReason = 'Insufficient completed weekly candles (18 < 20 for SMA, 50 for RSI)';
        rsi = null;
        sma = null;
      } else if (isNoQuote) {
        diagStatus = 'QUOTE_UNAVAILABLE';
        diagReason = 'Provider returned no valid quote';
        price = null;
      }

      results.push({
        rank: i,
        companyName: `Synthetic Company ${i} Ltd`,
        isin: `INE${String(i).padStart(9, '0')}`,
        canonicalNseSymbol: `SYNTH${i}`,
        upstoxInstrumentKey: `NSE_EQ|INE${String(i).padStart(9, '0')}`,
        lastPrice: price,
        quoteTimestamp: isStale ? '2026-10-20T10:00:00+05:30' : '2026-10-24T15:30:00+05:30',
        twentyWeekSma: sma,
        weeklyRsi: rsi,
        latestCompletedCandleDate: '2026-10-16',
        isStale,
        isQualified: isQualified && !isStale,
        diagnosticStatus: diagStatus,
        diagnosticReason: diagReason,
      });
    }

    return {
      universeVersion: 'amfi-2026-h2-v1',
      classificationPeriod: '2026-H2',
      sourcePeriodLabel: 'July - December 2026',
      evaluatedAt: '2026-10-25T10:30:00Z',
      totalConstituents: 100,
      qualifiedCount: 25,
      results,
    };
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    container = new MockElement('div');
    root = createRoot(container as unknown as HTMLElement);
    latestPortfolio = null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  const renderWithProviders = async (authenticated = true) => {
    if (authenticated) {
      vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    } else {
      vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(new AuthenticationError('Not authenticated'));
    }

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TestConsumer />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    // Allow effects to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  };

  // 1. Valid universe status and 100-stock screener table rendering
  it('renders valid large-cap universe status and 100-stock screener table with formatted values', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(validUniverseStatus);
    const mockScreen100 = generateSynthetic100ScreenResponse();
    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockResolvedValue(mockScreen100);

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    // Allow async data fetching in ScreenerView
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = screenerContainer.textContent;

    // Universe status active
    expect(text).toContain('Large-Cap Universe Active');
    expect(text).toContain('amfi-2026-h2-v1');
    expect(text).toContain('2026-H2');

    // Screener counts
    expect(text).toContain('All (100)');
    expect(text).toContain('Qualified Only (25)');
    expect(text).toContain('Showing 100 of 100 results');

    // First and last synthetic constituents present
    expect(text).toContain('SYNTH1');
    expect(text).toContain('Synthetic Company 1 Ltd');
    expect(text).toContain('SYNTH100');
    expect(text).toContain('Synthetic Company 100 Ltd');

    // Never renders demo stocks in authenticated mode
    expect(text).not.toContain('Demo Universe (Sample Data)');
    expect(text).not.toContain('SAMPLE_NSE_STOCKS');

    screenerRoot.unmount();
  });

  // 2. Server-side qualified-only filtering
  it('triggers fetchLargeCapUniverseScreen with qualified_only=true when clicking Qualified Only filter', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(validUniverseStatus);
    const mockScreen100 = generateSynthetic100ScreenResponse();
    const screenSpy = vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockImplementation(async (qualifiedOnly) => {
      if (qualifiedOnly) {
        return {
          ...mockScreen100,
          results: mockScreen100.results.filter((r) => r.isQualified),
        };
      }
      return mockScreen100;
    });

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screenSpy).toHaveBeenCalledWith(false);

    // Find and click the "Qualified Only" button
    const buttons = screenerContainer.querySelectorAll('button');
    const qualifiedOnlyBtn = buttons.find((b) => b.textContent.includes('Qualified Only'));
    expect(qualifiedOnlyBtn).toBeDefined();

    await act(async () => {
      simulateClick(qualifiedOnlyBtn!);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screenSpy).toHaveBeenCalledWith(true);
    expect(screenerContainer.textContent).toContain('Showing 25 of 25 results');

    screenerRoot.unmount();
  });

  // 3. Universe UNAVAILABLE state displays informative banner without fabricated stock table
  it('displays informative banner and no fabricated stock table when universe is UNAVAILABLE', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(unavailableUniverseStatus);
    const screenSpy = vi.spyOn(api, 'fetchLargeCapUniverseScreen');

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = screenerContainer.textContent;

    // Status banner for UNAVAILABLE
    expect(text).toContain('Large-Cap Universe Not Active (UNAVAILABLE)');
    expect(text).toContain('Large-cap universe artifact not found on server.');
    expect(text).toContain('Re-check Universe');

    // Did NOT call screen endpoint
    expect(screenSpy).not.toHaveBeenCalled();

    // No table rendered
    expect(screenerContainer.querySelector('table')).toBeNull();

    // Individual symbol lookup remains available
    expect(text).toContain('Verified NSE Market Data • Symbol Lookup');
    expect(text).toContain('Individual Symbol Lookup Mode');
    expect(screenerContainer.querySelector('#symbol-lookup-input')).not.toBeNull();

    screenerRoot.unmount();
  });

  // 4. Universe EXPIRED state displays informative banner
  it('displays informative banner when universe is EXPIRED', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(expiredUniverseStatus);

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = screenerContainer.textContent;
    expect(text).toContain('Large-Cap Universe Not Active (EXPIRED)');
    expect(text).toContain('Universe classification expired on 2026-06-30.');
    expect(screenerContainer.querySelector('table')).toBeNull();

    screenerRoot.unmount();
  });

  // 5. Universe INVALID state displays informative banner
  it('displays informative banner when universe is INVALID due to checksum or manifest failure', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(invalidUniverseStatus);

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = screenerContainer.textContent;
    expect(text).toContain('Large-Cap Universe Not Active (INVALID)');
    expect(text).toContain('Universe artifact checksum mismatch with sidecar manifest.');
    expect(screenerContainer.querySelector('table')).toBeNull();

    screenerRoot.unmount();
  });

  // 6. Universe NOT_YET_ACTIVE state displays informative banner
  it('displays informative banner when universe is NOT_YET_ACTIVE', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(notYetActiveUniverseStatus);

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = screenerContainer.textContent;
    expect(text).toContain('Large-Cap Universe Not Active (NOT_YET_ACTIVE)');
    expect(text).toContain('Classification becomes effective on 2027-01-01.');
    expect(screenerContainer.querySelector('table')).toBeNull();

    screenerRoot.unmount();
  });

  // 7. API Failure and Retry behavior
  it('displays error alert on universe status failure and allows retry', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    const statusSpy = vi.spyOn(api, 'fetchLargeCapUniverseStatus')
      .mockRejectedValueOnce(new ApiError(503, 'Upstox market-data gateway timeout'))
      .mockResolvedValueOnce(validUniverseStatus);

    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockResolvedValue(generateSynthetic100ScreenResponse());

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Error alert visible
    expect(screenerContainer.textContent).toContain('Universe Status Request Failed');
    expect(screenerContainer.textContent).toContain('Upstox market-data gateway timeout');

    // Click Retry
    const buttons = screenerContainer.querySelectorAll('button');
    const retryBtn = buttons.find((b) => b.textContent.includes('Retry'));
    expect(retryBtn).toBeDefined();

    await act(async () => {
      simulateClick(retryBtn!);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should now show valid universe
    expect(statusSpy).toHaveBeenCalledTimes(2);
    expect(screenerContainer.textContent).toContain('Large-Cap Universe Active');

    screenerRoot.unmount();
  });

  // 8. Stock-level diagnostic reasons and formatting unavailable values as '--'
  it('formats unavailable values as -- and displays stock-level diagnostics', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(validUniverseStatus);

    const syntheticResponse: UniverseScreenResponse = {
      universeVersion: 'amfi-2026-h2-v1',
      classificationPeriod: '2026-H2',
      sourcePeriodLabel: 'July - December 2026',
      evaluatedAt: '2026-10-25T10:30:00Z',
      totalConstituents: 3,
      qualifiedCount: 1,
      results: [
        {
          rank: 1,
          companyName: 'Qualified Leader Ltd',
          isin: 'INE001A01010',
          canonicalNseSymbol: 'QUALIFIED1',
          upstoxInstrumentKey: 'NSE_EQ|INE001A01010',
          lastPrice: 2500.0,
          quoteTimestamp: '2026-10-24T15:30:00+05:30',
          twentyWeekSma: 2400.0,
          weeklyRsi: 65.5,
          latestCompletedCandleDate: '2026-10-16',
          isStale: false,
          isQualified: true,
          diagnosticStatus: 'QUALIFIED',
          diagnosticReason: 'Qualified: Weekly RSI > 60',
        },
        {
          rank: 2,
          companyName: 'Stale Quote Ltd',
          isin: 'INE002A01010',
          canonicalNseSymbol: 'STALE2',
          upstoxInstrumentKey: 'NSE_EQ|INE002A01010',
          lastPrice: 1500.0,
          quoteTimestamp: '2026-10-20T10:00:00+05:30',
          twentyWeekSma: 1400.0,
          weeklyRsi: 62.0,
          latestCompletedCandleDate: '2026-10-16',
          isStale: true,
          isQualified: false,
          diagnosticStatus: 'STALE_QUOTE',
          diagnosticReason: 'Reference quote is older than 24 hours',
        },
        {
          rank: 3,
          companyName: 'Missing History Ltd',
          isin: 'INE003A01010',
          canonicalNseSymbol: 'MISSING3',
          upstoxInstrumentKey: 'NSE_EQ|INE003A01010',
          lastPrice: null, // missing quote
          quoteTimestamp: null,
          twentyWeekSma: null, // missing SMA
          weeklyRsi: null, // missing RSI
          latestCompletedCandleDate: null,
          isStale: false,
          isQualified: false,
          diagnosticStatus: 'INSUFFICIENT_HISTORY',
          diagnosticReason: 'Only 12 weekly candles available',
        },
      ],
    };

    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockResolvedValue(syntheticResponse);

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = screenerContainer.textContent;

    // Qualified stock has Open Entry button
    expect(text).toContain('QUALIFIED1');
    expect(text).toContain('Open Entry');

    // Stale stock has Stale Quote badge and disabled button
    expect(text).toContain('STALE2');
    expect(text).toContain('Stale Quote');
    expect(text).toContain('Reference quote is older than 24 hours');

    // Missing history stock formats missing values as '--' not 0
    expect(text).toContain('MISSING3');
    expect(text).toContain('--');
    expect(text).toContain('Insufficient Bars');
    expect(text).toContain('Only 12 weekly candles available');

    screenerRoot.unmount();
  });

  // 9. Open Entry launches TradeEntryModal with selected stock snapshot
  it('Open Entry launches TradeEntryModal with constituent market snapshot', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(validUniverseStatus);

    const syntheticResponse: UniverseScreenResponse = {
      universeVersion: 'amfi-2026-h2-v1',
      classificationPeriod: '2026-H2',
      sourcePeriodLabel: 'July - December 2026',
      evaluatedAt: '2026-10-25T10:30:00Z',
      totalConstituents: 1,
      qualifiedCount: 1,
      results: [
        {
          rank: 1,
          companyName: 'Tata Consultancy Services',
          isin: 'INE467B01029',
          canonicalNseSymbol: 'TCS',
          upstoxInstrumentKey: 'NSE_EQ|INE467B01029',
          lastPrice: 4120.0,
          quoteTimestamp: '2026-10-24T15:30:00+05:30',
          twentyWeekSma: 3950.0,
          weeklyRsi: 63.5,
          latestCompletedCandleDate: '2026-10-16',
          isStale: false,
          isQualified: true,
          diagnosticStatus: 'QUALIFIED',
          diagnosticReason: 'Qualified: Weekly RSI > 60',
        },
      ],
    };

    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockResolvedValue(syntheticResponse);

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Find and click Open Entry
    const buttons = screenerContainer.querySelectorAll('button');
    const openEntryBtn = buttons.find((b) => b.textContent.includes('Open Entry'));
    expect(openEntryBtn).toBeDefined();

    await act(async () => {
      simulateClick(openEntryBtn!);
    });

    // TradeEntryModal should be visible with TCS snapshot
    expect(screenerContainer.textContent).toContain('Trade Parameter & Sizing: TCS');
    expect(screenerContainer.textContent).toContain('TejHQ EOD Market Data (NSE Large-Cap Screener)');
    expect(screenerContainer.textContent).toContain('Live Verified Quote');
    expect(screenerContainer.textContent).toContain('₹4,120.00'); // entry price
    expect(screenerContainer.textContent).toContain('₹3,950.00'); // stop loss (20w SMA)
    expect(screenerContainer.textContent).toContain('63.5 ✓ PASS');

    screenerRoot.unmount();
  });

  // 10. Demo mode preserves sample data and paper-trading behavior
  it('preserves Demo Mode with Demo Universe (Sample Data) and mock stocks', async () => {
    // Demo mode: not authenticated
    await renderWithProviders(false);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    const text = screenerContainer.textContent;

    // Clearly labeled as Demo Mode & Sample Data
    expect(text).toContain('NSE Large-Cap Stock Screener (Demo Mode)');
    expect(text).toContain('Demo Universe (Sample Data)');
    expect(text).toContain('Sample Simulation Data');

    // Contains sample stock symbols from mock data
    expect(text).toContain(SAMPLE_NSE_STOCKS[0].symbol);
    expect(text).toContain(SAMPLE_NSE_STOCKS[0].displayName);

    // Contains demo mode action button
    expect(text).toContain("Let's Dive In");

    screenerRoot.unmount();
  });

  // 11. Provider-name display for TejHQ EOD market data
  it('displays TejHQ EOD market data subtitle and Verified TejHQ EOD badge when TejHQ is the active provider', async () => {
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(validUniverseStatus);
    const tejResponse: api.UniverseScreenResponse = {
      universeVersion: '2026.1',
      classificationPeriod: 'JAN_JUN_2026',
      evaluatedAt: '2026-10-24T15:30:00+05:30',
      totalConstituents: 100,
      qualifiedCount: 1,
      marketDataSource: 'TEJHQ',
      results: [
        {
          rank: 1,
          canonicalNseSymbol: 'INFY',
          companyName: 'Infosys Limited',
          isin: 'INE009A01021',
          upstoxInstrumentKey: '',
          lastPrice: 1850.0,
          quoteTimestamp: '2026-10-24T15:30:00+05:30',
          twentyWeekSma: 1750.0,
          weeklyRsi: 65.0,
          latestCompletedCandleDate: '2026-10-16',
          isStale: false,
          isQualified: true,
          diagnosticStatus: 'QUALIFIED',
          diagnosticReason: 'Qualified: Weekly RSI > 60',
        },
      ],
    };

    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockResolvedValue(tejResponse);

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = screenerContainer.textContent;
    expect(text).toContain('Authoritative screening against the verified NSE Large-Cap Universe with TejHQ EOD market data.');
    expect(text).toContain('Verified TejHQ EOD');
    expect(text).not.toContain('with Upstox market data');

    screenerRoot.unmount();
  });

  // 12. Provider-name display for Upstox market data
  it('displays Upstox market data subtitle and Verified Upstox badge when Upstox is the active provider', async () => {
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(validUniverseStatus);
    const upstoxResponse: api.UniverseScreenResponse = {
      universeVersion: '2026.1',
      classificationPeriod: 'JAN_JUN_2026',
      evaluatedAt: '2026-10-24T15:30:00+05:30',
      totalConstituents: 100,
      qualifiedCount: 1,
      marketDataSource: 'UPSTOX',
      results: [
        {
          rank: 1,
          canonicalNseSymbol: 'INFY',
          companyName: 'Infosys Limited',
          isin: 'INE009A01021',
          upstoxInstrumentKey: 'NSE_EQ|INE009A01021',
          lastPrice: 1850.0,
          quoteTimestamp: '2026-10-24T15:30:00+05:30',
          twentyWeekSma: 1750.0,
          weeklyRsi: 65.0,
          latestCompletedCandleDate: '2026-10-16',
          isStale: false,
          isQualified: true,
          diagnosticStatus: 'QUALIFIED',
          diagnosticReason: 'Qualified: Weekly RSI > 60',
        },
      ],
    };

    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockResolvedValue(upstoxResponse);

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const text = screenerContainer.textContent;
    expect(text).toContain('Authoritative screening against the verified NSE Large-Cap Universe with Upstox market data.');
    expect(text).toContain('Verified Upstox');

    screenerRoot.unmount();
  });

  // 13. Safeguard: displays Provider Error when screening fails
  it('displays Provider Error when screening fails and does not claim verification', async () => {
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(validUniverseStatus);
    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockRejectedValueOnce(
      new api.ApiError(500, 'Provider upstream connection refused')
    );

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screenerContainer.textContent).toContain('Provider Error');
    expect(screenerContainer.textContent).not.toContain('Verified TejHQ EOD');
    expect(screenerContainer.textContent).not.toContain('Verified Upstox');

    screenerRoot.unmount();
  });

  // 14. Safeguard: displays Stale Data when quotes are stale and does not claim verification
  it('displays Stale Data when quotes are stale and does not claim verification', async () => {
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(validUniverseStatus);
    const staleResponse: api.UniverseScreenResponse = {
      universeVersion: '2026.1',
      classificationPeriod: 'JAN_JUN_2026',
      evaluatedAt: '2026-10-24T15:30:00+05:30',
      totalConstituents: 100,
      qualifiedCount: 1,
      marketDataSource: 'TEJHQ',
      results: [
        {
          rank: 1,
          canonicalNseSymbol: 'INFY',
          companyName: 'Infosys Limited',
          isin: 'INE009A01021',
          upstoxInstrumentKey: '',
          lastPrice: 1850.0,
          quoteTimestamp: '2026-10-10T15:30:00+05:30',
          twentyWeekSma: 1750.0,
          weeklyRsi: 65.0,
          latestCompletedCandleDate: '2026-10-02',
          isStale: true,
          isQualified: true,
          diagnosticStatus: 'STALE',
          diagnosticReason: 'Market data is stale',
        },
      ],
    };

    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockResolvedValue(staleResponse);

    await renderWithProviders(true);

    const screenerContainer = new MockElement('div');
    const screenerRoot = createRoot(screenerContainer as unknown as HTMLElement);

    await act(async () => {
      screenerRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <ScreenerView />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screenerContainer.textContent).toContain('Stale Data');
    expect(screenerContainer.textContent).not.toContain('Verified TejHQ EOD');

    screenerRoot.unmount();
  });

  // 15. Consistency: Sidebar badge, screener filter tab, and qualified-only table in Authenticated Mode
  it('ensures sidebar badge, screener qualified count, and qualified-only table are in 100% agreement', async () => {
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(validUniverseStatus);

    const fourQualifiedResponse: api.UniverseScreenResponse = {
      universeVersion: '2026.1',
      classificationPeriod: 'JAN_JUN_2026',
      evaluatedAt: '2026-10-24T15:30:00+05:30',
      totalConstituents: 100,
      qualifiedCount: 4,
      marketDataSource: 'TEJHQ',
      results: [
        {
          rank: 1,
          canonicalNseSymbol: 'TCS',
          companyName: 'Tata Consultancy Services Ltd.',
          isin: 'INE467B01029',
          upstoxInstrumentKey: '',
          lastPrice: 2530.0,
          quoteTimestamp: '2026-10-24T15:30:00+05:30',
          twentyWeekSma: 2227.01,
          weeklyRsi: 60.07,
          latestCompletedCandleDate: '2026-10-16',
          isStale: false,
          isQualified: true,
          diagnosticStatus: 'QUALIFIED',
          diagnosticReason: 'Qualified: Weekly RSI > 60',
        },
        {
          rank: 2,
          canonicalNseSymbol: 'HCLTECH',
          companyName: 'HCL Technologies Ltd',
          isin: 'INE860A01027',
          upstoxInstrumentKey: '',
          lastPrice: 1422.2,
          quoteTimestamp: '2026-10-24T15:30:00+05:30',
          twentyWeekSma: 1240.89,
          weeklyRsi: 62.23,
          latestCompletedCandleDate: '2026-10-16',
          isStale: false,
          isQualified: true,
          diagnosticStatus: 'QUALIFIED',
          diagnosticReason: 'Qualified: Weekly RSI > 60',
        },
        {
          rank: 3,
          canonicalNseSymbol: 'DIVISLAB',
          companyName: "Divi's Laboratories Ltd.",
          isin: 'INE361B01024',
          upstoxInstrumentKey: '',
          lastPrice: 8950.0,
          quoteTimestamp: '2026-10-24T15:30:00+05:30',
          twentyWeekSma: 8237.97,
          weeklyRsi: 65.99,
          latestCompletedCandleDate: '2026-10-16',
          isStale: false,
          isQualified: true,
          diagnosticStatus: 'QUALIFIED',
          diagnosticReason: 'Qualified: Weekly RSI > 60',
        },
        {
          rank: 4,
          canonicalNseSymbol: 'TECHM',
          companyName: 'Tech Mahindra Limited',
          isin: 'INE669C01036',
          upstoxInstrumentKey: '',
          lastPrice: 1790.0,
          quoteTimestamp: '2026-10-24T15:30:00+05:30',
          twentyWeekSma: 1545.91,
          weeklyRsi: 68.53,
          latestCompletedCandleDate: '2026-10-16',
          isStale: false,
          isQualified: true,
          diagnosticStatus: 'QUALIFIED',
          diagnosticReason: 'Qualified: Weekly RSI > 60',
        },
      ],
    };

    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockImplementation(async (qualifiedOnly) => {
      if (qualifiedOnly) {
        return fourQualifiedResponse;
      }
      return {
        ...fourQualifiedResponse,
        totalConstituents: 100,
        results: fourQualifiedResponse.results,
      };
    });

    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });

    const appContainer = new MockElement('div');
    const appRoot = createRoot(appContainer as unknown as HTMLElement);

    await act(async () => {
      appRoot.render(
        <AuthProvider>
          <PortfolioProvider>
            <div>
              <Sidebar activeTab="screener" onTabChange={() => {}} />
              <ScreenerView />
            </div>
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const fullText = appContainer.textContent;

    // 1. Sidebar badge must display "4 Qualified" (NOT stale "5 Qualified")
    expect(fullText).toContain('4 Qualified');
    expect(fullText).not.toContain('5 Qualified');

    // 2. Stock Screener tab filter must display "Qualified Only (4)"
    expect(fullText).toContain('Qualified Only (4)');

    // 3. Qualified-only results contain exactly the 4 qualified stocks meeting weekly RSI > 60
    expect(fullText).toContain('TCS');
    expect(fullText).toContain('HCLTECH');
    expect(fullText).toContain('DIVISLAB');
    expect(fullText).toContain('TECHM');

    appRoot.unmount();
  });

  // 16. Consistency: Sidebar badge in Demo Mode reflects Demo sample eligible count
  it('displays 5 Qualified in Sidebar badge during Demo Mode matching sample stocks', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(new AuthenticationError('Not authenticated'));

    const demoContainer = new MockElement('div');
    const demoRoot = createRoot(demoContainer as unknown as HTMLElement);

    await act(async () => {
      demoRoot.render(
        <AuthProvider>
          <PortfolioProvider>
            <div>
              <Sidebar activeTab="screener" onTabChange={() => {}} />
              <ScreenerView />
            </div>
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const demoText = demoContainer.textContent;

    // In demo mode, exactly 5 mock stocks are eligible
    const eligibleCount = SAMPLE_NSE_STOCKS.filter((s) => s.isEligible).length;
    expect(eligibleCount).toBe(5);
    expect(demoText).toContain('5 Qualified');
    expect(demoText).toContain('NSE Large-Cap Stock Screener (Demo Mode)');

    demoRoot.unmount();
  });

  // 17. Dynamic Synchronization: when screener results update, sidebar badge immediately reflects new count
  it('dynamically synchronizes sidebar badge when screener qualified count updates', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue(validUniverseStatus);

    const dynamicResponse: api.UniverseScreenResponse = {
      universeVersion: '2026.1',
      classificationPeriod: 'JAN_JUN_2026',
      evaluatedAt: '2026-10-24T15:30:00+05:30',
      totalConstituents: 100,
      qualifiedCount: 7,
      marketDataSource: 'TEJHQ',
      results: [],
    };

    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockResolvedValue(dynamicResponse);

    const dynamicContainer = new MockElement('div');
    const dynamicRoot = createRoot(dynamicContainer as unknown as HTMLElement);

    await act(async () => {
      dynamicRoot.render(
        <AuthProvider>
          <PortfolioProvider>
            <div>
              <Sidebar activeTab="screener" onTabChange={() => {}} />
              <ScreenerView />
            </div>
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(dynamicContainer.textContent).toContain('7 Qualified');
    expect(dynamicContainer.textContent).toContain('Qualified Only (7)');

    dynamicRoot.unmount();
  });
});
