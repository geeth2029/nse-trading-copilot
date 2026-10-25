import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { PortfolioProvider, PortfolioContext, usePortfolio, type PortfolioContextType } from '../context/PortfolioContext';
import { ScreenerView } from '../features/screener/ScreenerView';
import { TradeEntryModal } from '../features/dashboard/TradeEntryModal';
import { PyramidModal } from '../features/portfolio/PyramidModal';
import * as api from '../services/api';
import {
  ApiError,
  AuthenticationError,
  type UserRead,
  type PortfolioPositionResponse,
  type MarketSnapshotRead,
} from '../services/api';
import type { ScreenerStock } from '../types/trading';
import { SAMPLE_NSE_STOCKS } from '../data/mockStocks';

// --- Minimal DOM Mock for React 19 in Node ---
class MockNode {}
class MockTextNode extends MockNode {
  nodeType = 3;
  nodeName = '#text';
  textContent: string;
  constructor(text = '') {
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
    if ('parentElement' in child) {
      (child as MockElement).parentElement = this;
    }
    return child;
  }

  removeChild(child: MockElement | MockTextNode) {
    this.childNodes = this.childNodes.filter((c) => c !== child);
    return child;
  }

  insertBefore(child: MockElement | MockTextNode, refChild: MockElement | MockTextNode | null = null) {
    const idx = refChild ? this.childNodes.indexOf(refChild) : -1;
    if (idx >= 0) {
      this.childNodes.splice(idx, 0, child);
    } else {
      this.childNodes.push(child);
    }
    if ('parentElement' in child) {
      (child as MockElement).parentElement = this;
    }
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

  get options(): MockElement[] {
    return this.findAll((el) => el.tagName === 'OPTION');
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
  globalThis.HTMLSelectElement = class extends MockElement {
    get options(): MockElement[] {
      return this.findAll((el) => el.tagName === 'OPTION');
    }
  };
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

function simulateChange(el: MockElement | null, value: string | boolean) {
  if (!el) throw new Error('Element not found');
  const props = getProps(el);
  if (typeof value === 'boolean') {
    el.checked = value;
    if (props.onChange) {
      props.onChange({ target: { checked: value, type: 'checkbox' } });
    }
  } else {
    el.value = value;
    if (props.onChange) {
      props.onChange({ target: { value } });
    }
  }
}

describe('Verified Market Data Integration (Phase 4.6E)', () => {
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
    id: 'user-46e',
    email: 'trader@example.com',
    displayName: 'Verified Trader',
    createdAt: '2026-10-25T10:00:00Z',
  };

  const sampleSnapshot: MarketSnapshotRead = {
    symbol: 'RELIANCE',
    instrumentIdentifier: 'NSE_EQ|INE002A01018',
    lastPrice: 2845.5,
    quoteTimestamp: '2026-10-24T15:30:00+05:30',
    twentyWeekSma: 2710.25,
    weeklyRsi: 64.8,
    latestCompletedCandleDate: '2026-10-16',
    completedCandlesCount: 22,
    isStale: false,
    isEligibleForInitial: true,
    statusReason: 'Qualified for initial entry: RSI 64.8 > 60 and price ₹2845.50 > 20w SMA ₹2710.25',
    source: 'Upstox API (NSE)',
  };

  const sampleBackendPosition: PortfolioPositionResponse = {
    id: 'pos-reliance-1',
    symbol: 'RELIANCE',
    companyName: 'Reliance Industries Ltd',
    status: 'ACTIVE',
    initialEntryDate: '2026-10-24',
    entries: [
      {
        id: 'entry-rel-1',
        positionId: 'pos-reliance-1',
        sequence: 1,
        entryType: 'INITIAL_ENTRY',
        entryDate: '2026-10-24',
        entryPrice: 2845.5,
        stopLoss: 2710.25,
        rps: 135.25,
        rpt: 5000.0,
        quantity: 36,
        capitalSnapshot: 500000.0,
        sizingStatus: 'VALID',
        entryPnl: null,
        notes: null,
      },
    ],
    exit: null,
    accumulatedQuantity: 36,
    averageEntryPrice: 2845.5,
    totalCapitalDeployed: 102438.0,
    currentReferencePrice: 2845.5,
    twentyWeekSmaStopLoss: 2710.25,
    latestWeeklyRsi: 64.8,
    isPyramidEligible: false,
    realizedPnl: null,
    unrealizedPnl: 0,
    archivedAt: null,
    archiveReason: null,
    createdAt: '2026-10-24T15:35:00Z',
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

  // 1. ScreenerView: Authenticated Mode renders Symbol Lookup, not SAMPLE_NSE_STOCKS
  it('ScreenerView in Authenticated Mode renders individual symbol lookup and excludes sample stocks', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchLargeCapUniverseStatus').mockResolvedValue({
      isAvailable: true,
      isValidForDate: true,
      status: 'VALID',
      datasetVersion: 'amfi-2026-h2-v1',
      sourcePeriodLabel: 'July - December 2026',
      classificationPeriod: '2026-H2',
      effectiveFrom: '2026-07-01',
      effectiveTo: '2026-12-31',
      constituentCount: 100,
      statusReason: 'Universe active and valid',
    });
    vi.spyOn(api, 'fetchLargeCapUniverseScreen').mockResolvedValue({
      universeVersion: '2026.1',
      classificationPeriod: 'JAN_JUN_2026',
      evaluatedAt: '2026-10-24T15:30:00+05:30',
      totalConstituents: 100,
      qualifiedCount: 0,
      marketDataSource: 'TEJHQ',
      results: [],
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

    // Verify authenticated mode header and notice
    expect(screenerContainer.textContent).toContain('Verified NSE Market Data • Symbol Lookup');
    expect(screenerContainer.textContent).toContain('Individual Symbol Lookup Mode');
    expect(screenerContainer.textContent).toContain('Verified TejHQ EOD');

    // Verify sample universe table is NOT displayed in Authenticated Mode
    expect(screenerContainer.textContent).not.toContain('Sample NSE Universe');
    expect(screenerContainer.textContent).not.toContain('Full NSE Screener Table');

    screenerRoot.unmount();
  });

  // 2. ScreenerView: Successful Symbol Lookup fetches and renders verified snapshot fields
  it('ScreenerView performs verified symbol lookup and renders snapshot attributes, source, and timestamps', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    const snapshotSpy = vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(sampleSnapshot);

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

    // Enter symbol into lookup input
    const input = screenerContainer.find((el) => el.getAttribute('id') === 'symbol-lookup-input');
    expect(input).toBeDefined();

    await act(async () => {
      simulateChange(input!, 'reliance');
    });

    // Click Lookup Symbol button
    const buttons = screenerContainer.findAll((el) => el.tagName === 'BUTTON');
    const lookupBtn = buttons.find((btn) => btn.textContent.includes('Lookup Symbol'));
    expect(lookupBtn).toBeDefined();

    await act(async () => {
      simulateClick(lookupBtn!);
      await new Promise((r) => setTimeout(r, 20));
    });

    // Verify API called with trimmed uppercase symbol
    expect(snapshotSpy).toHaveBeenCalledWith('RELIANCE');

    // Verify rendered snapshot attributes
    expect(screenerContainer.textContent).toContain('RELIANCE');
    expect(screenerContainer.textContent).toContain('NSE_EQ|INE002A01018');
    expect(screenerContainer.textContent).toContain('Upstox API (NSE)');
    expect(screenerContainer.textContent).toContain('2026-10-24T15:30:00+05:30');
    expect(screenerContainer.textContent).toContain('₹2,845.50');
    expect(screenerContainer.textContent).toContain('₹2,710.25');
    expect(screenerContainer.textContent).toContain('64.8');
    expect(screenerContainer.textContent).toContain('Strict > 60.0 PASS');
    expect(screenerContainer.textContent).toContain('22 bars');
    expect(screenerContainer.textContent).toContain('Qualified for Initial Entry');

    // "Open Initial Position" button must be enabled
    const openBtn = screenerContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Open Initial Position'));
    expect(openBtn).toBeDefined();
    expect(openBtn?.getAttribute('disabled')).toBeNull();

    screenerRoot.unmount();
  });

  // 3. ScreenerView: Displays error when symbol lookup fails without manufacturing data
  it('ScreenerView surfaces provider error on failed symbol lookup without inventing mock data', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    vi.spyOn(api, 'fetchMarketSnapshot').mockRejectedValue(new ApiError(404, "Instrument 'INVALID' not found in NSE master."));

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

    const input = screenerContainer.find((el) => el.getAttribute('id') === 'symbol-lookup-input');
    await act(async () => {
      simulateChange(input!, 'INVALID');
    });

    const lookupBtn = screenerContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Lookup Symbol'));
    await act(async () => {
      simulateClick(lookupBtn!);
      await new Promise((r) => setTimeout(r, 20));
    });

    // Check error banner
    expect(screenerContainer.textContent).toContain('Market Data Lookup Failed');
    expect(screenerContainer.textContent).toContain("Instrument 'INVALID' not found in NSE master.");
    // No snapshot card rendered
    expect(screenerContainer.textContent).not.toContain('Qualified for Initial Entry');

    screenerRoot.unmount();
  });

  // 4. ScreenerView: Stale quote disables initial entry button
  it('ScreenerView disables initial entry creation when snapshot is marked stale', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    const staleSnapshot: MarketSnapshotRead = {
      ...sampleSnapshot,
      isStale: true,
      statusReason: 'Quote is stale (35s old exceeds 30s market-hours TTL)',
    };
    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(staleSnapshot);

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

    const input = screenerContainer.find((el) => el.getAttribute('id') === 'symbol-lookup-input');
    await act(async () => {
      simulateChange(input!, 'RELIANCE');
    });

    const lookupBtn = screenerContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Lookup Symbol'));
    await act(async () => {
      simulateClick(lookupBtn!);
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(screenerContainer.textContent).toContain('Stale Quote');
    expect(screenerContainer.textContent).toContain('Quote is stale');

    const disabledBtn = screenerContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Entry Disabled (Stale Data)'));
    expect(disabledBtn).toBeDefined();
    expect(disabledBtn?.getAttribute('disabled')).not.toBeNull();

    screenerRoot.unmount();
  });

  // 5. ScreenerView: Weekly RSI <= 60 disables initial entry button
  it('ScreenerView disables initial entry creation when weekly RSI does not qualify (> 60 strict)', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    const ineligibleSnapshot: MarketSnapshotRead = {
      ...sampleSnapshot,
      weeklyRsi: 59.9,
      isEligibleForInitial: false,
      statusReason: 'Weekly RSI 59.90 does not qualify. Strict weekly RSI > 60.0 is required.',
    };
    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(ineligibleSnapshot);

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

    const input = screenerContainer.find((el) => el.getAttribute('id') === 'symbol-lookup-input');
    await act(async () => {
      simulateChange(input!, 'RELIANCE');
    });

    const lookupBtn = screenerContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Lookup Symbol'));
    await act(async () => {
      simulateClick(lookupBtn!);
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(screenerContainer.textContent).toContain('59.9');
    expect(screenerContainer.textContent).toContain('✗ Must be > 60.0');

    const disabledBtn = screenerContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Entry Disabled (RSI ≤ 60)'));
    expect(disabledBtn).toBeDefined();
    expect(disabledBtn?.getAttribute('disabled')).not.toBeNull();

    screenerRoot.unmount();
  });

  // 6. TradeEntryModal: Submits only server-authoritative fields (symbol, capital, notes)
  it('TradeEntryModal submits only server-authoritative payload (symbol, capital, notes) upon confirmation', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    const createPosSpy = vi.spyOn(api, 'createPortfolioPosition').mockResolvedValue(sampleBackendPosition);

    await renderWithProviders(true);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <TradeEntryModal
            snapshot={sampleSnapshot}
            isOpen={true}
            onClose={() => {}}
            onConfirmEntry={(snap, cap, notes) => latestPortfolio!.addInitialEntry(snap, cap, notes)}
          />
        </PortfolioContext.Provider>
      );
    });

    // Check preview sizing displayed
    expect(modalContainer.textContent).toContain('Deterministic Sizing Preview');
    expect(modalContainer.textContent).toContain('Server Authoritative');
    expect(modalContainer.textContent).toContain('RPT = ₹5,000.00');

    // Click Record Entry button
    const recordBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Record Entry'));
    expect(recordBtn).toBeDefined();

    await act(async () => {
      simulateClick(recordBtn!);
      await Promise.resolve();
    });

    // Verify exact server-authoritative request payload
    expect(createPosSpy).toHaveBeenCalledTimes(1);
    expect(createPosSpy).toHaveBeenCalledWith({
      symbol: 'RELIANCE',
      capital: 500000,
      notes: undefined,
    });

    modalRoot.unmount();
  });

  // 7. TradeEntryModal: Non-positive RPS warning enables submission upon acknowledgement
  it('TradeEntryModal preserves non-positive RPS warning with user acknowledgement', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    const createPosSpy = vi.spyOn(api, 'createPortfolioPosition').mockResolvedValue(sampleBackendPosition);

    await renderWithProviders(true);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <TradeEntryModal
            snapshot={sampleSnapshot}
            isOpen={true}
            onClose={() => {}}
            onConfirmEntry={(snap, cap, notes) => latestPortfolio!.addInitialEntry(snap, cap, notes)}
          />
        </PortfolioContext.Provider>
      );
    });

    // Simulate Stop-Loss >= Entry via test toggle
    const toggleBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Simulate Stop-Loss >= Entry'));
    expect(toggleBtn).toBeDefined();

    await act(async () => {
      simulateClick(toggleBtn!);
      await new Promise((r) => setTimeout(r, 10));
    });

    // Verify warning displayed and quantity is Unavailable
    expect(modalContainer.textContent).toContain('Critical Warning: Stop-Loss >= Reference Entry Price');
    expect(modalContainer.textContent).toContain('Unavailable');

    // Submit button should be disabled before acknowledgement
    const submitBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Save Entry (Null Size)'));
    expect(submitBtn?.getAttribute('disabled')).not.toBeNull();

    // Check acknowledgement checkbox
    const checkbox = modalContainer.find((el) => el.getAttribute('type') === 'checkbox');
    expect(checkbox).toBeDefined();

    await act(async () => {
      simulateChange(checkbox!, true);
      await new Promise((r) => setTimeout(r, 10));
    });

    // Submit button now enabled
    expect(submitBtn?.getAttribute('disabled')).toBeNull();

    await act(async () => {
      simulateClick(submitBtn!);
      await Promise.resolve();
    });

    // Server-side creation called with symbol and capital
    expect(createPosSpy).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'RELIANCE',
      capital: 500000,
    }));

    modalRoot.unmount();
  });

  // 8. PyramidModal: Fetches fresh market snapshot and evaluates inclusive ₹3 tolerance rule
  it('PyramidModal queries verified snapshot and evaluates inclusive ₹3 tolerance rule', async () => {
    const samplePyramidPosition: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      currentReferencePrice: 2890.0,
      twentyWeekSmaStopLoss: 2847.0,
      latestWeeklyRsi: 65.0,
    };
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [samplePyramidPosition] });
    // Previous entry price is 2845.50. Tolerance band is [2845.50, 2848.50].
    // SMA at 2847.00 is inside the band; RSI 65.0 > 60 passes.
    const pyramidEligibleSnapshot: MarketSnapshotRead = {
      ...sampleSnapshot,
      lastPrice: 2890.0,
      twentyWeekSma: 2847.0,
      weeklyRsi: 65.0,
    };
    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(pyramidEligibleSnapshot);
    const addPyramidSpy = vi.spyOn(api, 'addPyramidEntry').mockResolvedValue({
      ...samplePyramidPosition,
      entries: [...samplePyramidPosition.entries, {
        id: 'entry-rel-2',
        positionId: 'pos-reliance-1',
        sequence: 2,
        entryType: 'PYRAMID_ENTRY',
        entryDate: '2026-10-25',
        entryPrice: 2890.0,
        stopLoss: 2847.0,
        rps: 43.0,
        rpt: 5000.0,
        quantity: 116,
        capitalSnapshot: 500000.0,
        sizingStatus: 'VALID',
        entryPnl: null,
        notes: null,
      }],
      accumulatedQuantity: 152,
    });

    await renderWithProviders(true);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    const onConfirmPyramid = vi.fn().mockImplementation((posId, cap, notes) => {
      return latestPortfolio!.addPyramidEntry(posId, cap, notes);
    });

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PyramidModal
            position={samplePyramidPosition}
            isOpen={true}
            onClose={() => {}}
            onConfirmPyramid={onConfirmPyramid}
          />
        </PortfolioContext.Provider>
      );
    });

    // Wait for snapshot fetch in modal
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Verify conditions evaluation displayed
    expect(modalContainer.textContent).toContain('Pyramid Entry #2: RELIANCE');
    expect(modalContainer.textContent).toContain('Eligible for Pyramid');
    expect(modalContainer.textContent).toContain('1. Weekly RSI > 60 (Strict)');
    expect(modalContainer.textContent).toContain('65.0');
    expect(modalContainer.textContent).toContain('2. 20W SMA in [Prev, Prev + ₹3]');
    expect(modalContainer.textContent).toContain('₹2,847.00');

    // Click Confirm Pyramid button
    const confirmBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Confirm Pyramid #2'));
    expect(confirmBtn).toBeDefined();
    expect(confirmBtn?.getAttribute('disabled')).toBeNull();

    await act(async () => {
      simulateClick(confirmBtn!);
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(onConfirmPyramid).toHaveBeenCalledTimes(1);
    expect(addPyramidSpy).toHaveBeenCalledWith('pos-reliance-1', {
      capital: 500000,
      notes: undefined,
    });

    modalRoot.unmount();
  });

  // 9. PyramidModal: Ineligible conditions disable submission
  it('PyramidModal disables submission when 20w SMA is outside the [prev, prev + ₹3] band', async () => {
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [sampleBackendPosition] });
    // Previous entry price is 2845.50. SMA 2855.00 exceeds 2848.50.
    const outOfRangeSnapshot: MarketSnapshotRead = {
      ...sampleSnapshot,
      twentyWeekSma: 2855.0,
      weeklyRsi: 65.0,
    };
    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(outOfRangeSnapshot);

    await renderWithProviders(true);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PyramidModal
            position={sampleBackendPosition}
            isOpen={true}
            onClose={() => {}}
            onConfirmPyramid={() => {}}
          />
        </PortfolioContext.Provider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(modalContainer.textContent).toContain('Not Eligible');
    const disabledBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Pyramid Ineligible'));
    expect(disabledBtn).toBeDefined();
    expect(disabledBtn?.getAttribute('disabled')).not.toBeNull();

    modalRoot.unmount();
  });

  // 10. Demo Mode: Isolation and zero backend writes
  it('Demo Mode remains fully functional with SAMPLE_NSE_STOCKS and makes zero backend API writes', async () => {
    const fetchPositionsSpy = vi.spyOn(api, 'fetchPortfolioPositions');
    const createPosSpy = vi.spyOn(api, 'createPortfolioPosition');
    const addPyramidSpy = vi.spyOn(api, 'addPyramidEntry');

    await renderWithProviders(false);

    expect(latestPortfolio?.isDemoMode).toBe(true);

    // Create a new stock not in mock active positions
    const newDemoStock: ScreenerStock = {
      ...SAMPLE_NSE_STOCKS[0],
      symbol: 'NEWSTOCK',
      displayName: 'New Demo Stock Ltd',
    };

    // Initial paper trade creation in Demo Mode
    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.addInitialEntry(newDemoStock, 500000);
    });

    expect(result?.success).toBe(true);
    expect(result?.positionId).toBeDefined();

    // Verify ZERO backend writes called
    expect(createPosSpy).not.toHaveBeenCalled();
    expect(addPyramidSpy).not.toHaveBeenCalled();
    expect(fetchPositionsSpy).not.toHaveBeenCalled();
  });
});
