import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { PortfolioProvider, PortfolioContext, usePortfolio, type PortfolioContextType } from '../context/PortfolioContext';
import { PortfolioView } from '../features/portfolio/PortfolioView';
import { PyramidModal } from '../features/portfolio/PyramidModal';
import * as api from '../services/api';
import {
  type UserRead,
  type PortfolioPositionResponse,
  type MarketSnapshotRead,
} from '../services/api';
import { evaluatePyramidingEligibility } from '../services/calculations';

// --- Complete Minimal DOM Mock for React 19 Client Rendering in Node ---
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

  get title() {
    return this.attributes['title'] || '';
  }
  set title(val: string) {
    this.attributes['title'] = String(val);
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
    if (name === 'title' && this.attributes['title']) return this.attributes['title'];
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
  globalThis.HTMLSelectElement = class extends MockElement {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLDocument = function () {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.Document = function () {};

  globalThis.document = {
    nodeType: 9,
    nodeName: '#document',
    ownerDocument: null,
    defaultView: globalThis,
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
    props.onClick({ target: el, currentTarget: el, preventDefault: () => {}, stopPropagation: () => {} });
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

describe('TCS Pyramid-Entry Workflow: Disabled vs Enabled Scenarios & Safeguards', () => {
  let container: MockElement;
  let root: ReturnType<typeof createRoot>;
  let latestPortfolio: PortfolioContextType | null = null;

  const mockUser: UserRead = {
    id: 'user-tcs-eval',
    email: 'trader@example.com',
    displayName: 'Active Trader',
    createdAt: '2026-10-25T10:00:00Z',
  };

  // User's exact TCS position parameters
  const tcsRejectedPosition: PortfolioPositionResponse = {
    id: 'pos-tcs-user',
    symbol: 'TCS',
    companyName: 'Tata Consultancy Services Limited',
    status: 'ACTIVE',
    initialEntryDate: '2026-10-15',
    createdAt: '2026-10-15T09:30:00Z',
    archiveReason: null,
    archivedAt: null,
    accumulatedQuantity: 39,
    averageEntryPrice: 2533.0,
    totalCapitalDeployed: 98787.0,
    currentReferencePrice: 2533.0,
    twentyWeekSmaStopLoss: 2227.01, // ₹305.99 below entry price!
    latestWeeklyRsi: 60.07,         // Strictly > 60.0 PASS
    isPyramidEligible: false,
    unrealizedPnl: 0,
    realizedPnl: null,
    entries: [
      {
        id: 'entry-tcs-1',
        positionId: 'pos-tcs-user',
        sequence: 1,
        entryType: 'INITIAL_ENTRY',
        entryDate: '2026-10-15',
        entryPrice: 2533.0,
        stopLoss: 2227.01,
        rps: 305.99,
        rpt: 10000.0,
        quantity: 39,
        capitalSnapshot: 1000000.0,
        sizingStatus: 'VALID',
        entryPnl: null,
      },
    ],
    exit: null,
  };

  function TestConsumer() {
    const portfolio = usePortfolio();
    useEffect(() => {
      latestPortfolio = portfolio;
    });
    return null;
  }

  const renderWithProviders = async (initialPositions: PortfolioPositionResponse[] = [tcsRejectedPosition]) => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: initialPositions });

    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TestConsumer />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    // Wait for microtasks / effects to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    latestPortfolio = null;
    container = new MockElement('div');
    root = createRoot(container as unknown as HTMLElement);
  });

  // 1. Math and rule confirmation for user's exact TCS position
  it('confirms that the current TCS position is correctly rejected by the 20W SMA tolerance rule', () => {
    // Exact user values:
    const prevEntryPrice = 2533.0;
    const twentyWeekSma = 2227.01;
    const weeklyRsi = 60.07;

    const evaluation = evaluatePyramidingEligibility(weeklyRsi, twentyWeekSma, prevEntryPrice);

    // RSI > 60.0 passes
    expect(evaluation.rsiConditionMet).toBe(true);
    expect(evaluation.weeklyRsi).toBe(60.07);

    // SMA is 2227.01, required band is [2533.00, 2536.00]
    expect(evaluation.smaConditionMet).toBe(false);
    expect(evaluation.twentyWeekSma).toBe(2227.01);
    expect(evaluation.previousEntryPrice).toBe(2533.0);
    expect(evaluation.isEligible).toBe(false);

    // Reasons identify the exact discrepancy
    expect(evaluation.reasons).toContain('20-week SMA (₹2227.01) < Prev Entry (₹2533.00)');
  });

  // 2. PortfolioView card displays disabled "Pyramid Status" button for TCS
  it('PortfolioView displays disabled "Pyramid Status" button and tooltip explaining SMA failure for TCS', async () => {
    await renderWithProviders([tcsRejectedPosition]);

    const viewContainer = new MockElement('div');
    const viewRoot = createRoot(viewContainer as unknown as HTMLElement);

    await act(async () => {
      viewRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PortfolioView />
        </PortfolioContext.Provider>
      );
    });

    // Check position header rendered
    expect(viewContainer.textContent).toContain('TCS');
    expect(viewContainer.textContent).toContain('Tata Consultancy Services Limited');

    // Find the pyramid button
    const buttons = viewContainer.findAll((el) => el.tagName === 'BUTTON');
    const pyramidBtn = buttons.find((btn) => btn.textContent.includes('Pyramid Status'));

    expect(pyramidBtn).toBeDefined();
    expect(pyramidBtn?.getAttribute('disabled')).not.toBeNull();
    expect(pyramidBtn?.title).toContain('Ineligible');
    expect(pyramidBtn?.title).toContain('20-week SMA (₹2227.01) < Prev Entry (₹2533.00)');
  });

  // 3. Positive scenario: 2533.00 <= SMA <= 2536.00 and RSI > 60.0 enables pyramid action in PortfolioView
  it('PortfolioView displays enabled "Pyramid (+1)" button when TCS qualifies under positive scenario', async () => {
    const tcsEligiblePosition: PortfolioPositionResponse = {
      ...tcsRejectedPosition,
      twentyWeekSmaStopLoss: 2534.5, // 2533.00 <= 2534.50 <= 2536.00
      latestWeeklyRsi: 65.2,         // > 60.0
      isPyramidEligible: true,
    };

    await renderWithProviders([tcsEligiblePosition]);

    const viewContainer = new MockElement('div');
    const viewRoot = createRoot(viewContainer as unknown as HTMLElement);

    await act(async () => {
      viewRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PortfolioView />
        </PortfolioContext.Provider>
      );
    });

    const buttons = viewContainer.findAll((el) => el.tagName === 'BUTTON');
    const pyramidBtn = buttons.find((btn) => btn.textContent.includes('Pyramid (+1)'));

    expect(pyramidBtn).toBeDefined();
    expect(pyramidBtn?.getAttribute('disabled')).toBeNull();
    expect(pyramidBtn?.title).toBe('Qualifies for pyramiding');
  });

  // 4. Positive scenario in PyramidModal: Displays verified eligibility, calculates sizing, and enables confirmation
  it('PyramidModal displays verified eligibility, computes sizing, and accepts reference-price confirmation', async () => {
    const tcsEligiblePosition: PortfolioPositionResponse = {
      ...tcsRejectedPosition,
      currentReferencePrice: 2550.0,
      twentyWeekSmaStopLoss: 2534.5,
      latestWeeklyRsi: 65.2,
      isPyramidEligible: true,
    };

    const eligibleSnapshot: MarketSnapshotRead = {
      symbol: 'TCS',
      instrumentIdentifier: 'NSE_EQ|INE467B01029',
      lastPrice: 2550.0,
      quoteTimestamp: '2026-10-25T15:30:00+05:30',
      twentyWeekSma: 2534.5,
      weeklyRsi: 65.2,
      latestCompletedCandleDate: '2026-10-23',
      completedCandlesCount: 24,
      isStale: false,
      isEligibleForInitial: true,
      statusReason: 'Qualified for entry',
      source: 'TejHQ EOD',
    };

    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(eligibleSnapshot);
    const onConfirmPyramid = vi.fn().mockResolvedValue({ success: true });

    await renderWithProviders([tcsEligiblePosition]);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PyramidModal
            position={tcsEligiblePosition}
            isOpen={true}
            onClose={() => {}}
            onConfirmPyramid={onConfirmPyramid}
          />
        </PortfolioContext.Provider>
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    // Check conditions evaluation
    expect(modalContainer.textContent).toContain('Pyramid Entry #2: TCS');
    expect(modalContainer.textContent).toContain('Eligible for Pyramid');
    expect(modalContainer.textContent).toContain('1. Weekly RSI > 60 (Strict)');
    expect(modalContainer.textContent).toContain('65.2');
    expect(modalContainer.textContent).toContain('2. 20W SMA in [Prev, Prev + ₹3]');
    expect(modalContainer.textContent).toContain('₹2,534.50');

    // Confirm reference price checkbox is present
    const refConfirmContainer = modalContainer.findAll((el) => el.getAttribute('role') === 'checkbox')[0];
    expect(refConfirmContainer).toBeDefined();

    // Toggle reference price confirmation checkbox
    await act(async () => {
      simulateClick(refConfirmContainer);
      await new Promise((r) => setTimeout(r, 10));
    });

    // Submit pyramid entry
    const confirmBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Confirm Pyramid #2'));
    expect(confirmBtn).toBeDefined();
    expect(confirmBtn?.getAttribute('disabled')).toBeNull();

    await act(async () => {
      simulateClick(confirmBtn!);
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(onConfirmPyramid).toHaveBeenCalledTimes(1);
    expect(onConfirmPyramid).toHaveBeenCalledWith(
      'pos-tcs-user',
      500000,
      expect.objectContaining({
        confirmReferencePriceAsExecution: true,
      }),
      expect.objectContaining({
        confirmReferencePriceAsExecution: true,
      })
    );
  });

  // 5. Positive scenario with explicit execution-price confirmation
  it('PyramidModal supports submitting an explicit execution-price confirmation', async () => {
    const tcsEligiblePosition: PortfolioPositionResponse = {
      ...tcsRejectedPosition,
      currentReferencePrice: 2550.0,
      twentyWeekSmaStopLoss: 2534.5,
      latestWeeklyRsi: 65.2,
      isPyramidEligible: true,
    };

    const eligibleSnapshot: MarketSnapshotRead = {
      symbol: 'TCS',
      instrumentIdentifier: 'NSE_EQ|INE467B01029',
      lastPrice: 2550.0,
      quoteTimestamp: '2026-10-25T15:30:00+05:30',
      twentyWeekSma: 2534.5,
      weeklyRsi: 65.2,
      latestCompletedCandleDate: '2026-10-23',
      completedCandlesCount: 24,
      isStale: false,
      isEligibleForInitial: true,
      statusReason: 'Qualified for entry',
      source: 'TejHQ EOD',
    };

    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(eligibleSnapshot);
    const onConfirmPyramid = vi.fn().mockResolvedValue({ success: true });

    await renderWithProviders([tcsEligiblePosition]);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PyramidModal
            position={tcsEligiblePosition}
            isOpen={true}
            onClose={() => {}}
            onConfirmPyramid={onConfirmPyramid}
          />
        </PortfolioContext.Provider>
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    // Enter custom execution price ₹2545.00
    const inputs = modalContainer.findAll((el) => el.tagName === 'INPUT');
    const execInput = inputs.find((inp) => inp.getAttribute('step') === '0.05');
    expect(execInput).toBeDefined();

    await act(async () => {
      simulateChange(execInput!, '2545.00');
      await new Promise((r) => setTimeout(r, 10));
    });

    const confirmBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Confirm Pyramid #2'));
    expect(confirmBtn).toBeDefined();
    expect(confirmBtn?.getAttribute('disabled')).toBeNull();

    await act(async () => {
      simulateClick(confirmBtn!);
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(onConfirmPyramid).toHaveBeenCalledWith(
      'pos-tcs-user',
      500000,
      expect.objectContaining({
        executionPrice: 2545.0,
      }),
      expect.objectContaining({
        executionPrice: 2545.0,
      })
    );
  });

  // 6. Negative scenario: Stale market data quote disables submission
  it('PyramidModal disables submission when market snapshot is stale', async () => {
    const tcsEligiblePosition: PortfolioPositionResponse = {
      ...tcsRejectedPosition,
      currentReferencePrice: 2550.0,
      twentyWeekSmaStopLoss: 2534.5,
      latestWeeklyRsi: 65.2,
      isPyramidEligible: true,
    };

    const staleSnapshot: MarketSnapshotRead = {
      symbol: 'TCS',
      instrumentIdentifier: 'NSE_EQ|INE467B01029',
      lastPrice: 2550.0,
      quoteTimestamp: '2026-10-25T15:30:00+05:30',
      twentyWeekSma: 2534.5,
      weeklyRsi: 65.2,
      latestCompletedCandleDate: '2026-10-23',
      completedCandlesCount: 24,
      isStale: true, // Stale!
      isEligibleForInitial: false,
      statusReason: 'Quote is older than permitted TTL',
      source: 'TejHQ EOD',
    };

    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(staleSnapshot);

    await renderWithProviders([tcsEligiblePosition]);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PyramidModal
            position={tcsEligiblePosition}
            isOpen={true}
            onClose={() => {}}
            onConfirmPyramid={vi.fn()}
          />
        </PortfolioContext.Provider>
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(modalContainer.textContent).toContain('Stale Market Data Quote');
    const disabledBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Stale Market Data'));
    expect(disabledBtn).toBeDefined();
    expect(disabledBtn?.getAttribute('disabled')).not.toBeNull();
  });

  // 7. Negative scenario: Weekly RSI <= 60.0 disables submission
  it('PyramidModal disables submission when weekly RSI <= 60.0 (boundary check)', async () => {
    const tcsEligiblePosition: PortfolioPositionResponse = {
      ...tcsRejectedPosition,
      currentReferencePrice: 2550.0,
      twentyWeekSmaStopLoss: 2534.5,
      latestWeeklyRsi: 60.0, // 60.0 is not strictly > 60.0!
      isPyramidEligible: false,
    };

    const rsiSnapshot: MarketSnapshotRead = {
      symbol: 'TCS',
      instrumentIdentifier: 'NSE_EQ|INE467B01029',
      lastPrice: 2550.0,
      quoteTimestamp: '2026-10-25T15:30:00+05:30',
      twentyWeekSma: 2534.5,
      weeklyRsi: 60.0,
      latestCompletedCandleDate: '2026-10-23',
      completedCandlesCount: 24,
      isStale: false,
      isEligibleForInitial: false,
      statusReason: 'RSI <= 60',
      source: 'TejHQ EOD',
    };

    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(rsiSnapshot);

    await renderWithProviders([tcsEligiblePosition]);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PyramidModal
            position={tcsEligiblePosition}
            isOpen={true}
            onClose={() => {}}
            onConfirmPyramid={vi.fn()}
          />
        </PortfolioContext.Provider>
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(modalContainer.textContent).toContain('Not Eligible');
    expect(modalContainer.textContent).toContain('✗ Must be strictly > 60.0');

    const disabledBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Pyramid Ineligible'));
    expect(disabledBtn).toBeDefined();
    expect(disabledBtn?.getAttribute('disabled')).not.toBeNull();
  });

  // 8. Negative scenario: Out-of-range SMA disables submission
  it('PyramidModal disables submission when 20W SMA exceeds previous entry + ₹3.00', async () => {
    const tcsEligiblePosition: PortfolioPositionResponse = {
      ...tcsRejectedPosition,
      currentReferencePrice: 2550.0,
      twentyWeekSmaStopLoss: 2536.5, // > 2536.00 (exceeds band)
      latestWeeklyRsi: 65.2,
      isPyramidEligible: false,
    };

    const smaSnapshot: MarketSnapshotRead = {
      symbol: 'TCS',
      instrumentIdentifier: 'NSE_EQ|INE467B01029',
      lastPrice: 2550.0,
      quoteTimestamp: '2026-10-25T15:30:00+05:30',
      twentyWeekSma: 2536.5,
      weeklyRsi: 65.2,
      latestCompletedCandleDate: '2026-10-23',
      completedCandlesCount: 24,
      isStale: false,
      isEligibleForInitial: true,
      statusReason: 'Qualified for entry',
      source: 'TejHQ EOD',
    };

    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(smaSnapshot);

    await renderWithProviders([tcsEligiblePosition]);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PyramidModal
            position={tcsEligiblePosition}
            isOpen={true}
            onClose={() => {}}
            onConfirmPyramid={vi.fn()}
          />
        </PortfolioContext.Provider>
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(modalContainer.textContent).toContain('Not Eligible');
    expect(modalContainer.textContent).toContain('20-week SMA (₹2536.50) > Prev Entry + 3 (₹2536.00)');

    const disabledBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Pyramid Ineligible'));
    expect(disabledBtn).toBeDefined();
    expect(disabledBtn?.getAttribute('disabled')).not.toBeNull();
  });

  // 9. Negative scenario: Insufficient capital (zero shares) disables submission
  it('PyramidModal disables submission when capital allocation results in zero whole shares', async () => {
    const tcsEligiblePosition: PortfolioPositionResponse = {
      ...tcsRejectedPosition,
      currentReferencePrice: 2550.0,
      twentyWeekSmaStopLoss: 2534.5,
      latestWeeklyRsi: 65.2,
      isPyramidEligible: true,
    };

    const eligibleSnapshot: MarketSnapshotRead = {
      symbol: 'TCS',
      instrumentIdentifier: 'NSE_EQ|INE467B01029',
      lastPrice: 2550.0,
      quoteTimestamp: '2026-10-25T15:30:00+05:30',
      twentyWeekSma: 2534.5,
      weeklyRsi: 65.2,
      latestCompletedCandleDate: '2026-10-23',
      completedCandlesCount: 24,
      isStale: false,
      isEligibleForInitial: true,
      statusReason: 'Qualified for entry',
      source: 'TejHQ EOD',
    };

    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(eligibleSnapshot);

    await renderWithProviders([tcsEligiblePosition]);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PyramidModal
            position={tcsEligiblePosition}
            isOpen={true}
            onClose={() => {}}
            onConfirmPyramid={vi.fn()}
          />
        </PortfolioContext.Provider>
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    // Enter very low capital (₹1,000) where 1% RPT = ₹10.00, RPS = ₹15.50 -> 0 shares
    const inputs = modalContainer.findAll((el) => el.tagName === 'INPUT');
    const capitalInput = inputs.find((inp) => inp.getAttribute('step') === '50000');
    expect(capitalInput).toBeDefined();

    await act(async () => {
      simulateChange(capitalInput!, '1000');
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(modalContainer.textContent).toContain('0 shares');
    expect(modalContainer.textContent).toContain('Insufficient Capital Allocation');

    const submitBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Confirm Pyramid'));
    expect(submitBtn).toBeDefined();
    expect(submitBtn?.getAttribute('disabled')).not.toBeNull();
  });

  // 10. Negative scenario: Invalid execution price (<= 0) disables submission
  it('PyramidModal disables submission when custom execution price is non-positive or invalid', async () => {
    const tcsEligiblePosition: PortfolioPositionResponse = {
      ...tcsRejectedPosition,
      currentReferencePrice: 2550.0,
      twentyWeekSmaStopLoss: 2534.5,
      latestWeeklyRsi: 65.2,
      isPyramidEligible: true,
    };

    const eligibleSnapshot: MarketSnapshotRead = {
      symbol: 'TCS',
      instrumentIdentifier: 'NSE_EQ|INE467B01029',
      lastPrice: 2550.0,
      quoteTimestamp: '2026-10-25T15:30:00+05:30',
      twentyWeekSma: 2534.5,
      weeklyRsi: 65.2,
      latestCompletedCandleDate: '2026-10-23',
      completedCandlesCount: 24,
      isStale: false,
      isEligibleForInitial: true,
      statusReason: 'Qualified for entry',
      source: 'TejHQ EOD',
    };

    vi.spyOn(api, 'fetchMarketSnapshot').mockResolvedValue(eligibleSnapshot);

    await renderWithProviders([tcsEligiblePosition]);

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <PyramidModal
            position={tcsEligiblePosition}
            isOpen={true}
            onClose={() => {}}
            onConfirmPyramid={vi.fn()}
          />
        </PortfolioContext.Provider>
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    // Enter negative execution price
    const inputs = modalContainer.findAll((el) => el.tagName === 'INPUT');
    const execInput = inputs.find((inp) => inp.getAttribute('step') === '0.05');
    expect(execInput).toBeDefined();

    await act(async () => {
      simulateChange(execInput!, '-2500');
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(modalContainer.textContent).toContain('Execution price must be a valid positive number greater than ₹0.00');

    const submitBtn = modalContainer.findAll((el) => el.tagName === 'BUTTON').find((b) => b.textContent.includes('Confirm Pyramid'));
    expect(submitBtn).toBeDefined();
    expect(submitBtn?.getAttribute('disabled')).not.toBeNull();
  });
});
