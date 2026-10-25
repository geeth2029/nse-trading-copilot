import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthProvider, useAuth, type AuthContextType } from '../context/AuthContext';
import { PortfolioProvider, PortfolioContext, usePortfolio, type PortfolioContextType } from '../context/PortfolioContext';
import { TradeEntryModal } from '../features/dashboard/TradeEntryModal';
import { PyramidModal } from '../features/portfolio/PyramidModal';
import { RecordExitModal } from '../features/portfolio/RecordExitModal';
import { ArchiveModal } from '../features/portfolio/ArchiveModal';
import { ArchivedView } from '../features/archived/ArchivedView';
import * as api from '../services/api';
import {
  AuthenticationError,
  ApiError,
  NetworkError,
  type UserRead,
  type PortfolioPositionResponse,
} from '../services/api';
import { SAMPLE_NSE_STOCKS } from '../data/mockStocks';

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
  const props = getProps(el);
  if (props.onClick) {
    props.onClick({ target: el, currentTarget: el, preventDefault: () => {} });
  }
}

describe('Portfolio Read, Mode, & Position Creation Integration (Phase 4.5D)', () => {
  let container: MockElement;
  let root: ReturnType<typeof createRoot>;
  let latestPortfolio: PortfolioContextType | null = null;

  const mockUser: UserRead = {
    id: 'user-001',
    email: 'investor@example.com',
    displayName: 'Active Investor',
    createdAt: '2026-10-24T12:00:00Z',
  };

  const sampleBackendPosition: PortfolioPositionResponse = {
    id: 'pos-backend-1',
    symbol: 'HDFCBANK',
    companyName: 'HDFC Bank Limited',
    status: 'ACTIVE',
    initialEntryDate: '2026-10-20',
    createdAt: '2026-10-20T10:00:00Z',
    archiveReason: null,
    archivedAt: null,
    accumulatedQuantity: 150,
    averageEntryPrice: 1520.5,
    totalCapitalDeployed: 228075,
    currentReferencePrice: null,
    twentyWeekSmaStopLoss: null,
    latestWeeklyRsi: null,
    isPyramidEligible: null,
    unrealizedPnl: null,
    realizedPnl: null,
    entries: [
      {
        id: 'entry-backend-1',
        positionId: 'pos-backend-1',
        sequence: 1,
        entryType: 'INITIAL_ENTRY',
        entryDate: '2026-10-20',
        entryPrice: 1520.5,
        stopLoss: 1470.0,
        rps: 50.5,
        rpt: 10000.0,
        quantity: 150,
        capitalSnapshot: 1000000.0,
        sizingStatus: 'VALID',
        entryPnl: null,
      },
    ],
    exit: null,
  };

  let latestAuth: AuthContextType | null = null;

  function TestConsumer() {
    const portfolio = usePortfolio();
    const auth = useAuth();
    useEffect(() => {
      latestPortfolio = portfolio;
      latestAuth = auth;
    });
    return null;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    latestPortfolio = null;
    latestAuth = null;
    container = new MockElement('div');
    root = createRoot(container as unknown as HTMLElement);
  });

  const renderWithProviders = async () => {
    await act(async () => {
      root.render(
        <AuthProvider>
          <PortfolioProvider>
            <TestConsumer />
          </PortfolioProvider>
        </AuthProvider>
      );
    });
  };

  // 1. Defaults to Demo Mode when unauthenticated
  it('defaults to Demo Mode when unauthenticated and presents demo active positions', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(new AuthenticationError('Not authenticated'));
    const fetchPositionsSpy = vi.spyOn(api, 'fetchPortfolioPositions');

    await renderWithProviders();

    expect(latestPortfolio?.portfolioMode).toBe('demo');
    expect(latestPortfolio?.isDemoMode).toBe(true);
    expect(latestPortfolio?.activePositions.length).toBeGreaterThan(0);
    expect(fetchPositionsSpy).not.toHaveBeenCalled();
  });

  // 2. Reject switching to Authenticated Mode when unauthenticated
  it('prevents entering Authenticated Mode when unauthenticated', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(new AuthenticationError('Not authenticated'));

    await renderWithProviders();

    expect(latestPortfolio?.portfolioMode).toBe('demo');

    await act(async () => {
      latestPortfolio?.setPortfolioMode('authenticated');
    });

    expect(latestPortfolio?.portfolioMode).toBe('demo');
    expect(latestPortfolio?.isDemoMode).toBe(true);
  });

  // 3. Transitions to Authenticated Mode upon login and triggers fetchPortfolioPositions
  it('transitions to Authenticated Mode on login and queries fetchPortfolioPositions()', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const fetchPositionsSpy = vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.isDemoMode).toBe(false);
    expect(fetchPositionsSpy).toHaveBeenCalledTimes(1);
    expect(latestPortfolio?.activePositions.length).toBe(1);
    expect(latestPortfolio?.activePositions[0].symbol).toBe('HDFCBANK');
  });

  // 4. Authenticated user with empty portfolio sees 0 positions, NEVER demo positions
  it('never displays demo positions when an authenticated user has zero saved positions', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [],
    });

    await renderWithProviders();

    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.activePositions).toEqual([]);
    expect(latestPortfolio?.archivedPositions).toEqual([]);
    expect(latestPortfolio?.summary.activePositionsCount).toBe(0);
    expect(latestPortfolio?.summary.totalQuantity).toBe(0);
    expect(latestPortfolio?.summary.totalCapitalDeployed).toBe(0);
  });

  // 5. Correctly preserves nullable backend fields without coercing to zero
  it('correctly preserves nullable backend fields without inventing zero or quotes', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    const position = latestPortfolio?.activePositions[0];
    expect(position).toBeDefined();
    expect(position?.currentReferencePrice).toBeNull();
    expect(position?.twentyWeekSmaStopLoss).toBeNull();
    expect(position?.latestWeeklyRsi).toBeNull();
    expect(position?.isPyramidEligible).toBeNull();
    expect(position?.unrealizedPnl).toBeNull();
    expect(position?.realizedPnl).toBeNull();
  });

  // 6. Handles API errors (HTTP 500) and preserves empty state without falling back to demo
  it('handles backend API errors (HTTP 500) safely without falling back to demo positions', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockRejectedValue(new ApiError(500, 'Internal Server Error'));

    await renderWithProviders();

    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.portfolioError).toBe('Internal Server Error');
    expect(latestPortfolio?.isLoadingPortfolio).toBe(false);
    expect(latestPortfolio?.activePositions).toEqual([]);
    expect(latestPortfolio?.archivedPositions).toEqual([]);
  });

  // 7. Handles HTTP 401 safely without falling back to demo positions
  it('handles HTTP 401 AuthenticationError safely without falling back to demo positions', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockRejectedValue(new AuthenticationError('Session expired or invalid'));

    await renderWithProviders();

    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.portfolioError).toContain('Authentication required or session expired');
    expect(latestPortfolio?.activePositions).toEqual([]);
  });

  // 8. Handles NetworkError
  it('handles NetworkError safely', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockRejectedValue(new NetworkError('Network connection failed'));

    await renderWithProviders();

    expect(latestPortfolio?.portfolioError).toBe('Network connection failed');
    expect(latestPortfolio?.activePositions).toEqual([]);
  });

  // 9. Allows retrying portfolio reads via refreshPortfolio()
  it('allows retrying failed portfolio reads using refreshPortfolio()', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const fetchPositionsSpy = vi
      .spyOn(api, 'fetchPortfolioPositions')
      .mockRejectedValueOnce(new ApiError(503, 'Temporary Service Error'))
      .mockResolvedValueOnce({
        positions: [sampleBackendPosition],
      });

    await renderWithProviders();

    expect(latestPortfolio?.portfolioError).toBe('Temporary Service Error');
    expect(latestPortfolio?.activePositions).toEqual([]);

    await act(async () => {
      await latestPortfolio?.refreshPortfolio();
    });

    expect(latestPortfolio?.portfolioError).toBeNull();
    expect(latestPortfolio?.activePositions.length).toBe(1);
    expect(latestPortfolio?.activePositions[0].symbol).toBe('HDFCBANK');
    expect(fetchPositionsSpy).toHaveBeenCalledTimes(2);
  });

  // 10. Allows authenticated users to switch freely between Demo Mode and Authenticated Mode
  it('allows authenticated users to toggle between Demo Mode and Authenticated Mode', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.activePositions[0].symbol).toBe('HDFCBANK');

    // Switch to Demo
    await act(async () => {
      latestPortfolio?.setPortfolioMode('demo');
    });

    expect(latestPortfolio?.portfolioMode).toBe('demo');
    expect(latestPortfolio?.isDemoMode).toBe(true);
    // Now displays demo mock positions
    expect(latestPortfolio?.activePositions.length).toBeGreaterThan(0);
    expect(latestPortfolio?.activePositions.map((p) => p.symbol)).not.toContain('HDFCBANK');

    // Switch back to Authenticated
    await act(async () => {
      latestPortfolio?.setPortfolioMode('authenticated');
    });

    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.isDemoMode).toBe(false);
    expect(latestPortfolio?.activePositions[0].symbol).toBe('HDFCBANK');
  });

  // 11. Authenticated creation is blocked while verified market data is unavailable
  it('blocks initial position creation via addInitialEntry() in Authenticated Mode while verified market data is unavailable', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const fetchPositionsSpy = vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });
    const createPositionSpy = vi.spyOn(api, 'createPortfolioPosition');

    await renderWithProviders();

    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.activePositions).toEqual([]);

    const infyStock = {
      ...SAMPLE_NSE_STOCKS[0],
      symbol: 'INFY',
      displayName: 'Infosys Limited',
      referencePrice: 1950.0,
      twentyWeekSma: 1800.0,
      weeklyRsi: 64.5,
      isEligible: true,
    };

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.addInitialEntry(infyStock, 500000);
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toBe(
      'Authenticated entry creation is temporarily unavailable because verified NSE market data has not been connected.'
    );

    // Verify backend createPosition was NOT called with sample mock data
    expect(createPositionSpy).not.toHaveBeenCalled();

    // Verify no fake positions or entries were added to authenticated portfolio
    expect(latestPortfolio?.activePositions).toEqual([]);
    expect(latestPortfolio?.recentActivity).toEqual([]);
    expect(fetchPositionsSpy).toHaveBeenCalledTimes(1);
  });

  // 12. TradeEntryModal displays warning and disables submission when in Authenticated Mode
  it('TradeEntryModal displays verified market data required warning and disables submit when in Authenticated Mode', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });

    await renderWithProviders();
    expect(latestPortfolio?.isDemoMode).toBe(false);

    const mockConfirmEntry = vi.fn();
    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    const testStock = {
      ...SAMPLE_NSE_STOCKS[0],
      symbol: 'INFY',
      referencePrice: 1950.0,
      twentyWeekSma: 1800.0,
      weeklyRsi: 65.0,
      isEligible: true,
    };

    await act(async () => {
      modalRoot.render(
        <PortfolioContext.Provider value={latestPortfolio!}>
          <TradeEntryModal
            stock={testStock}
            isOpen={true}
            onClose={() => {}}
            onConfirmEntry={mockConfirmEntry}
          />
        </PortfolioContext.Provider>
      );
    });

    // Check for warning alert
    const alerts = modalContainer.findAll((el) => el.getAttribute('role') === 'alert');
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].textContent).toContain('Verified NSE Market Data Required');
    expect(alerts[0].textContent).toContain('Authenticated entry creation is temporarily unavailable');

    // Find submit button and verify disabled state
    const buttons = modalContainer.findAll((el) => el.tagName === 'BUTTON');
    const submitBtn = buttons.find((btn) => btn.textContent.includes('Creation Disabled'));
    expect(submitBtn).toBeDefined();
    expect(submitBtn?.getAttribute('disabled')).not.toBeNull();

    // Attempt click
    await act(async () => {
      simulateClick(submitBtn!);
    });

    expect(mockConfirmEntry).not.toHaveBeenCalled();
  });

  // 13. TradeEntryModal allows submitting when in Demo Mode
  it('TradeEntryModal allows submitting paper trade entries when in Demo Mode', async () => {
    const mockConfirmEntry = vi.fn().mockResolvedValue({ success: true });
    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    const testStock = {
      ...SAMPLE_NSE_STOCKS[0],
      symbol: 'INFY',
      referencePrice: 1950.0,
      twentyWeekSma: 1800.0,
      weeklyRsi: 65.0,
      isEligible: true,
    };

    await act(async () => {
      modalRoot.render(
        <TradeEntryModal
          stock={testStock}
          isOpen={true}
          onClose={() => {}}
          onConfirmEntry={mockConfirmEntry}
        />
      );
    });

    const buttons = modalContainer.findAll((el) => el.tagName === 'BUTTON');
    const recordBtn = buttons.find((btn) => btn.textContent.includes('Record Entry'));
    expect(recordBtn).toBeDefined();
    expect(recordBtn?.getAttribute('disabled')).toBeNull();

    await act(async () => {
      simulateClick(recordBtn!);
    });

    expect(mockConfirmEntry).toHaveBeenCalledTimes(1);
  });

  // 14. Demo Mode continues local paper trading without making backend API calls
  it('preserves Demo Mode paper trading without making backend API calls', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(new AuthenticationError('Not authenticated'));
    const createPositionSpy = vi.spyOn(api, 'createPortfolioPosition');

    await renderWithProviders();

    expect(latestPortfolio?.isDemoMode).toBe(true);
    const initialCount = latestPortfolio?.activePositions.length ?? 0;

    const newStock = {
      ...SAMPLE_NSE_STOCKS[0],
      symbol: 'NEWDEMOSTOCK',
      displayName: 'New Demo Stock Ltd',
      referencePrice: 1000,
      twentyWeekSma: 900,
    };

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.addInitialEntry(newStock, 500000);
    });

    expect(result?.success).toBe(true);
    expect(createPositionSpy).not.toHaveBeenCalled();
    expect(latestPortfolio?.activePositions.length).toBe(initialCount + 1);
    expect(latestPortfolio?.activePositions[0].symbol).toBe('NEWDEMOSTOCK');
  });

  // 16. Rejects restoring non-archived position in Authenticated Mode
  it('safely rejects restoring a position that is not archived in Authenticated Mode', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    let restoreRes: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      restoreRes = await latestPortfolio?.restorePosition('pos-backend-1');
    });
    expect(restoreRes?.success).toBe(false);
    expect(restoreRes?.error).toContain('Position is not archived');
  });

  // 17. TradeEntryModal handles loading state and duplicate submission prevention
  it('TradeEntryModal shows submitting state and prevents duplicate submissions while saving', async () => {
    let confirmCalls = 0;
    let resolveConfirm: (val: { success: boolean; error?: string }) => void = () => {};
    const confirmPromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
      resolveConfirm = resolve;
    });

    const mockConfirmEntry = vi.fn().mockImplementation(() => {
      confirmCalls++;
      return confirmPromise;
    });

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    const testStock = {
      ...SAMPLE_NSE_STOCKS[0],
      symbol: 'INFY',
      referencePrice: 1950.0,
      twentyWeekSma: 1800.0,
      weeklyRsi: 65.0,
      isEligible: true,
    };

    await act(async () => {
      modalRoot.render(
        <TradeEntryModal
          stock={testStock}
          isOpen={true}
          onClose={() => {}}
          onConfirmEntry={mockConfirmEntry}
        />
      );
    });

    // Find the submit button
    const buttons = modalContainer.findAll((el) => el.tagName === 'BUTTON');
    const recordBtn = buttons.find((btn) => btn.textContent.includes('Record Entry') || btn.textContent.includes('Record Paper Entry'));
    expect(recordBtn).toBeDefined();

    // Trigger first click
    await act(async () => {
      simulateClick(recordBtn!);
    });

    expect(confirmCalls).toBe(1);

    // Trigger duplicate click while submission is pending
    await act(async () => {
      simulateClick(recordBtn!);
    });

    // Must NOT call confirmEntry a second time
    expect(confirmCalls).toBe(1);

    // Resolve the submission
    await act(async () => {
      resolveConfirm({ success: true });
    });
  });

  // 18. Successful authenticated pyramid entry via addPyramidEntry
  it('creates a pyramid entry via addPyramidEntry() in Authenticated Mode with correct payload and refreshes portfolio', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const fetchPositionsSpy = vi.spyOn(api, 'fetchPortfolioPositions');

    const initialPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      id: 'pos-eligible-1',
      currentReferencePrice: 1560.0,
      twentyWeekSmaStopLoss: 1522.0, // within [1520.5, 1523.5]
      latestWeeklyRsi: 66.5, // > 60.0
      isPyramidEligible: true,
      entries: [sampleBackendPosition.entries[0]], // entryPrice: 1520.5
    };
    fetchPositionsSpy.mockResolvedValueOnce({ positions: [initialPos] });

    const updatedPos: PortfolioPositionResponse = {
      ...initialPos,
      accumulatedQuantity: 281, // 150 + 131
      averageEntryPrice: 1538.9,
      totalCapitalDeployed: initialPos.totalCapitalDeployed + (1560.0 * 131),
      entries: [
        initialPos.entries[0],
        {
          id: 'entry-backend-2',
          positionId: 'pos-eligible-1',
          sequence: 2,
          entryType: 'PYRAMID_ENTRY',
          entryDate: '2026-10-24',
          entryPrice: 1560.0,
          stopLoss: 1522.0,
          rps: 38.0,
          rpt: 5000.0,
          quantity: 131,
          capitalSnapshot: 500000.0,
          sizingStatus: 'VALID',
          entryPnl: null,
          notes: 'Pyramid #1: RSI 66.5 > 60 and SMA ₹1522.00 in range',
        },
      ],
    };

    const addPyramidSpy = vi.spyOn(api, 'addPyramidEntry').mockResolvedValue(updatedPos);
    fetchPositionsSpy.mockResolvedValueOnce({ positions: [updatedPos] });

    await renderWithProviders();

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.addPyramidEntry('pos-eligible-1', 500000);
    });

    expect(result?.success).toBe(true);
    expect(result?.positionId).toBe('pos-eligible-1');

    // Verify request payload matches the backend schema strictly: only user capital and optional notes
    expect(addPyramidSpy).toHaveBeenCalledTimes(1);
    expect(addPyramidSpy).toHaveBeenCalledWith('pos-eligible-1', {
      capital: 500000,
      notes: undefined,
    });

    // Verify portfolio was refreshed and active positions updated
    expect(fetchPositionsSpy).toHaveBeenCalledTimes(2);
    expect(latestPortfolio?.activePositions[0].entries.length).toBe(2);
    expect(latestPortfolio?.activePositions[0].accumulatedQuantity).toBe(281);
  });

  // 19. API error handling on pyramid entry
  it('does not add fake entry or mutate position if addPyramidEntry API call fails', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const initialPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      id: 'pos-fail-1',
      currentReferencePrice: 1560.0,
      twentyWeekSmaStopLoss: 1522.0,
      latestWeeklyRsi: 66.5,
      entries: [sampleBackendPosition.entries[0]],
    };
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [initialPos] });
    vi.spyOn(api, 'addPyramidEntry').mockRejectedValue(new ApiError(409, 'Cannot add pyramid entries to an exited position.'));

    await renderWithProviders();

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.addPyramidEntry('pos-fail-1', 500000);
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toBe('Cannot add pyramid entries to an exited position.');
    // Position must NOT have added a fake entry
    expect(latestPortfolio?.activePositions[0].entries.length).toBe(1);
  });

  // 20. HTTP 401 handling on pyramid entry
  it('handles HTTP 401 on pyramid entry safely without falling back to demo records', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const initialPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      id: 'pos-auth-err-1',
      currentReferencePrice: 1560.0,
      twentyWeekSmaStopLoss: 1522.0,
      latestWeeklyRsi: 66.5,
      entries: [sampleBackendPosition.entries[0]],
    };
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [initialPos] });
    vi.spyOn(api, 'addPyramidEntry').mockRejectedValue(new AuthenticationError('Session expired.'));

    await renderWithProviders();

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.addPyramidEntry('pos-auth-err-1', 500000);
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Authentication required or session expired');
    expect(latestPortfolio?.portfolioError).toContain('Authentication required or session expired');
    // Must remain isolated from demo records
    expect(latestPortfolio?.isDemoMode).toBe(false);
  });

  // 21. Rejects pyramid entry if live technical data is missing for position in Authenticated Mode
  it('rejects pyramid entry if live technical data is missing for position in Authenticated Mode', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const initialPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      id: 'pos-missing-tech-1',
      currentReferencePrice: null,
      twentyWeekSmaStopLoss: null,
      latestWeeklyRsi: null,
      entries: [sampleBackendPosition.entries[0]],
    };
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [initialPos] });
    const addPyramidSpy = vi.spyOn(api, 'addPyramidEntry');

    await renderWithProviders();

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.addPyramidEntry('pos-missing-tech-1', 500000);
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('unavailable');
    expect(addPyramidSpy).not.toHaveBeenCalled();
  });

  // 22. Rejects pyramid entry if trading rules fail (RSI <= 60 or SMA out of range)
  it('rejects pyramid entry if trading rules fail (RSI <= 60 or SMA out of range)', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const initialPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      id: 'pos-rule-fail-1',
      currentReferencePrice: 1560.0,
      twentyWeekSmaStopLoss: 1522.0,
      latestWeeklyRsi: 58.0, // Fails RSI > 60
      entries: [sampleBackendPosition.entries[0]],
    };
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [initialPos] });
    const addPyramidSpy = vi.spyOn(api, 'addPyramidEntry');

    await renderWithProviders();

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.addPyramidEntry('pos-rule-fail-1', 500000);
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Pyramiding eligibility failed');
    expect(addPyramidSpy).not.toHaveBeenCalled();
  });

  // 23. Preserves Demo Mode paper trading pyramid entry without making backend API calls
  it('preserves Demo Mode paper trading pyramid entry without making backend API calls', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(new AuthenticationError('Not authenticated'));
    const addPyramidSpy = vi.spyOn(api, 'addPyramidEntry');

    await renderWithProviders();

    expect(latestPortfolio?.isDemoMode).toBe(true);

    const demoStock = {
      ...SAMPLE_NSE_STOCKS[0],
      symbol: 'CUSTOMDEMO',
      referencePrice: 1005.0,
      twentyWeekSma: 1006.0,
      weeklyRsi: 65.0,
      isEligible: true,
    };

    let initialRes: { success: boolean; positionId?: string } | undefined;
    await act(async () => {
      initialRes = await latestPortfolio?.addInitialEntry(demoStock, 500000, 950.0);
    });

    expect(initialRes?.success).toBe(true);
    const posId = initialRes!.positionId!;

    let pyramidRes: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      pyramidRes = await latestPortfolio?.addPyramidEntry(posId, 500000);
    });

    expect(pyramidRes?.success).toBe(true);
    expect(addPyramidSpy).not.toHaveBeenCalled();

    const updatedDemoPos = latestPortfolio?.activePositions.find((p) => p.id === posId);
    expect(updatedDemoPos?.entries.length).toBe(2);
  });

  // 24. PyramidModal handles loading state and duplicate submission prevention
  it('PyramidModal shows submitting state and prevents duplicate submissions while saving', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });

    let confirmCalls = 0;
    let resolveConfirm: (val: { success: boolean; error?: string }) => void = () => {};
    const confirmPromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
      resolveConfirm = resolve;
    });

    const mockConfirmPyramid = vi.fn().mockImplementation(() => {
      confirmCalls++;
      return confirmPromise;
    });

    const eligiblePos: any = {
      id: 'pos-test-pyramid-1',
      symbol: 'INFY',
      companyName: 'Infosys Limited',
      status: 'ACTIVE',
      accumulatedQuantity: 33,
      currentReferencePrice: 1950.0,
      twentyWeekSmaStopLoss: 1802.0,
      latestWeeklyRsi: 65.0,
      isPyramidEligible: true,
      entries: [
        {
          id: 'entry-1',
          positionId: 'pos-test-pyramid-1',
          sequence: 1,
          entryType: 'INITIAL_ENTRY',
          entryDate: '2026-10-20',
          entryPrice: 1800.0,
          stopLoss: 1750.0,
          rps: 50.0,
          rpt: 5000.0,
          quantity: 33,
          capitalSnapshot: 500000,
          sizingStatus: 'VALID',
        },
      ],
    };

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <AuthProvider>
          <PortfolioProvider>
            <PyramidModal
              position={eligiblePos}
              isOpen={true}
              onClose={() => {}}
              onConfirmPyramid={mockConfirmPyramid}
            />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    // Find the confirm pyramid button
    const buttons = modalContainer.findAll((el) => el.tagName === 'BUTTON');
    const confirmBtn = buttons.find((btn) => btn.textContent.includes('Confirm Pyramid'));
    expect(confirmBtn).toBeDefined();

    // Trigger first click
    await act(async () => {
      simulateClick(confirmBtn!);
    });

    expect(confirmCalls).toBe(1);

    // Trigger duplicate click while submission is pending
    await act(async () => {
      simulateClick(confirmBtn!);
    });

    // Must NOT call confirmPyramid a second time
    expect(confirmCalls).toBe(1);

    // Resolve the submission
    await act(async () => {
      resolveConfirm({ success: true });
    });
  });

  // 25. PyramidModal displays warning and disables submit when technical data is missing
  it('PyramidModal displays warning and disables submit when technical data is missing', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({ positions: [] });

    const missingTechPos: any = {
      id: 'pos-test-missing-1',
      symbol: 'INFY',
      companyName: 'Infosys Limited',
      status: 'ACTIVE',
      accumulatedQuantity: 33,
      currentReferencePrice: null,
      twentyWeekSmaStopLoss: null,
      latestWeeklyRsi: null,
      isPyramidEligible: null,
      entries: [
        {
          id: 'entry-1',
          positionId: 'pos-test-missing-1',
          sequence: 1,
          entryType: 'INITIAL_ENTRY',
          entryDate: '2026-10-20',
          entryPrice: 1800.0,
          stopLoss: 1750.0,
          rps: 50.0,
          rpt: 5000.0,
          quantity: 33,
          capitalSnapshot: 500000,
          sizingStatus: 'VALID',
        },
      ],
    };

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <AuthProvider>
          <PortfolioProvider>
            <PyramidModal
              position={missingTechPos}
              isOpen={true}
              onClose={() => {}}
              onConfirmPyramid={vi.fn()}
            />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    const buttons = modalContainer.findAll((el) => el.tagName === 'BUTTON');
    const disabledBtn = buttons.find((btn) => btn.textContent.includes('Market Data Unavailable') || btn.textContent.includes('Pyramid Ineligible'));
    expect(disabledBtn).toBeDefined();

    // Warning message must be displayed
    const warningText = modalContainer.textContent;
    expect(warningText).toContain('Technical Market Data Unavailable');
  });

  // 26. Successful authenticated exit via recordPositionExit
  it('records a position exit via recordPositionExit() in Authenticated Mode with correct payload and refreshes portfolio', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.activePositions.length).toBe(1);

    const completedPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      status: 'COMPLETED',
      realizedPnl: 11925.0,
      unrealizedPnl: 0,
      isPyramidEligible: false,
      entries: [
        {
          ...sampleBackendPosition.entries[0],
          entryPnl: 11925.0,
        },
      ],
      exit: {
        id: 'exit-101',
        positionId: 'pos-backend-1',
        exitPrice: 1600.0,
        exitDate: '2026-10-24',
        recordedAt: '2026-10-24T15:30:00Z',
        notes: 'Target reached',
      },
    };

    const recordExitSpy = vi.spyOn(api, 'recordPositionExit').mockResolvedValue(completedPos);
    const refreshSpy = vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [completedPos],
    });

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.recordPositionExit(
        'pos-backend-1',
        1600.0,
        '2026-10-24',
        'Target reached'
      );
    });

    expect(result?.success).toBe(true);
    expect(result?.positionId).toBe('pos-backend-1');
    expect(recordExitSpy).toHaveBeenCalledWith('pos-backend-1', {
      exitPrice: 1600.0,
      exitDate: '2026-10-24',
      notes: 'Target reached',
    });
    expect(refreshSpy).toHaveBeenCalled();

    // Verify completed position data and P&L
    expect(latestPortfolio?.activePositions[0].status).toBe('COMPLETED');
    expect(latestPortfolio?.activePositions[0].realizedPnl).toBe(11925.0);
    expect(latestPortfolio?.activePositions[0].exit?.exitPrice).toBe(1600.0);
    expect(latestPortfolio?.activePositions[0].entries[0].entryPnl).toBe(11925.0);
  });

  // 27. Does not mutate position or add fake exit if recordPositionExit API call fails
  it('does not add fake exit or mutate position if recordPositionExit API call fails', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    vi.spyOn(api, 'recordPositionExit').mockRejectedValue(
      new ApiError(409, 'An exit has already been recorded for this position.')
    );

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.recordPositionExit('pos-backend-1', 1600.0, '2026-10-24');
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('already been recorded');

    // Position remains active and unexited
    const pos = latestPortfolio?.activePositions.find((p) => p.id === 'pos-backend-1');
    expect(pos?.status).toBe('ACTIVE');
    expect(pos?.exit).toBeNull();
  });

  // 28. Handles HTTP 401 on position exit safely without falling back to demo records
  it('handles HTTP 401 on position exit safely without falling back to demo records', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    vi.spyOn(api, 'recordPositionExit').mockRejectedValue(
      new AuthenticationError('Session expired.')
    );

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.recordPositionExit('pos-backend-1', 1600.0, '2026-10-24');
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Authentication required or session expired');
    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.portfolioError).toContain('Authentication required');
  });

  // 29. Rejects exit if exit date precedes initial entry date
  it('rejects exit if exit date precedes initial entry date', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition], // initialEntryDate is '2026-10-20'
    });

    await renderWithProviders();

    const recordExitSpy = vi.spyOn(api, 'recordPositionExit');

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.recordPositionExit('pos-backend-1', 1600.0, '2026-10-15');
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Exit date cannot precede initial entry date');
    expect(recordExitSpy).not.toHaveBeenCalled();
  });

  // 30. Preserves Demo Mode paper trading exit without making backend API calls
  it('preserves Demo Mode paper trading exit without making backend API calls', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(new AuthenticationError('Not authenticated'));
    await renderWithProviders();

    expect(latestPortfolio?.isDemoMode).toBe(true);
    const demoPos = latestPortfolio?.activePositions[0];
    expect(demoPos).toBeDefined();

    const recordExitSpy = vi.spyOn(api, 'recordPositionExit');

    let exitRes: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      exitRes = await latestPortfolio?.recordPositionExit(demoPos!.id, 2800.0, '2026-10-24');
    });

    expect(exitRes?.success).toBe(true);
    expect(recordExitSpy).not.toHaveBeenCalled();

    const updatedDemoPos = latestPortfolio?.activePositions.find((p) => p.id === demoPos!.id);
    expect(updatedDemoPos?.status).toBe('COMPLETED');
    expect(updatedDemoPos?.exit).toBeDefined();
    expect(updatedDemoPos?.exit?.exitPrice).toBe(2800.0);
  });

  // 31. RecordExitModal shows submitting state and prevents duplicate submissions while saving
  it('RecordExitModal shows submitting state and prevents duplicate submissions while saving', async () => {
    let confirmCalls = 0;
    let resolveConfirm: (val: { success: boolean; error?: string }) => void = () => {};
    const confirmPromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
      resolveConfirm = resolve;
    });

    const mockConfirmExit = vi.fn().mockImplementation(() => {
      confirmCalls++;
      return confirmPromise;
    });

    const activePos: any = {
      id: 'pos-test-exit-1',
      symbol: 'INFY',
      companyName: 'Infosys Limited',
      status: 'ACTIVE',
      initialEntryDate: '2026-10-01',
      accumulatedQuantity: 50,
      currentReferencePrice: 1950.0,
      entries: [
        {
          id: 'entry-1',
          positionId: 'pos-test-exit-1',
          sequence: 1,
          entryType: 'INITIAL_ENTRY',
          entryDate: '2026-10-01',
          entryPrice: 1800.0,
          quantity: 50,
        },
      ],
    };

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <RecordExitModal
          position={activePos}
          isOpen={true}
          onClose={() => {}}
          onConfirmExit={mockConfirmExit}
        />
      );
    });

    const buttons = modalContainer.findAll((el) => el.tagName === 'BUTTON');
    const confirmBtn = buttons.find((btn) => btn.textContent.includes('Confirm Position Exit'));
    expect(confirmBtn).toBeDefined();

    // First click
    await act(async () => {
      simulateClick(confirmBtn!);
    });

    expect(confirmCalls).toBe(1);

    // Duplicate click while in-flight
    await act(async () => {
      simulateClick(confirmBtn!);
    });

    expect(confirmCalls).toBe(1);

    // Resolve
    await act(async () => {
      resolveConfirm({ success: true });
    });
  });

  // 32. RecordExitModal displays unavailable message when entries have unavailable sizing
  it('RecordExitModal preserves unavailable state when sizing is unavailable', async () => {
    const unavailablePos: any = {
      id: 'pos-test-unavail-1',
      symbol: 'TCS',
      companyName: 'Tata Consultancy Services',
      status: 'ACTIVE',
      initialEntryDate: '2026-10-01',
      accumulatedQuantity: 0,
      currentReferencePrice: 3500.0,
      entries: [
        {
          id: 'entry-1',
          positionId: 'pos-test-unavail-1',
          sequence: 1,
          entryType: 'INITIAL_ENTRY',
          entryDate: '2026-10-01',
          entryPrice: 3400.0,
          quantity: null,
        },
      ],
    };

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <RecordExitModal
          position={unavailablePos}
          isOpen={true}
          onClose={() => {}}
          onConfirmExit={vi.fn()}
        />
      );
    });

    const text = modalContainer.textContent;
    expect(text).toContain('Unavailable');
    expect(text).toContain('consolidated P&L cannot be computed');
  });

  // 33. Successful authenticated archive via archivePosition
  it('archives a position via archivePosition() in Authenticated Mode with correct payload and refreshes portfolio', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.activePositions.length).toBe(1);
    expect(latestPortfolio?.archivedPositions.length).toBe(0);

    const archivedPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      status: 'ARCHIVED',
      archivedAt: '2026-10-24T18:00:00Z',
      archiveReason: 'Completed trade profit target',
    };

    const archiveSpy = vi.spyOn(api, 'archivePortfolioPosition').mockResolvedValue(archivedPos);
    const refreshSpy = vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [archivedPos],
    });

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.archivePosition(
        'pos-backend-1',
        'Completed trade profit target'
      );
    });

    expect(result?.success).toBe(true);
    expect(result?.positionId).toBe('pos-backend-1');
    expect(archiveSpy).toHaveBeenCalledWith('pos-backend-1', {
      reason: 'Completed trade profit target',
    });
    expect(refreshSpy).toHaveBeenCalled();

    // Position moves out of active list and into archived list
    expect(latestPortfolio?.activePositions.length).toBe(0);
    expect(latestPortfolio?.archivedPositions.length).toBe(1);

    // Verify preservation of complete entry history, metadata, and reason
    const archived = latestPortfolio?.archivedPositions[0];
    expect(archived?.id).toBe('pos-backend-1');
    expect(archived?.status).toBe('ARCHIVED');
    expect(archived?.archiveReason).toBe('Completed trade profit target');
    expect(archived?.archivedAt).toBe('2026-10-24T18:00:00Z');
    expect(archived?.entries.length).toBe(1);
    expect(archived?.entries[0].entryPrice).toBe(1520.5);
    expect(archived?.entries[0].quantity).toBe(150);
    expect(archived?.accumulatedQuantity).toBe(150);
  });

  // 34. Does not mutate position or add fake archive if archivePosition API call fails
  it('does not add fake archive or mutate position if archivePosition API call fails', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    vi.spyOn(api, 'archivePortfolioPosition').mockRejectedValue(
      new ApiError(500, 'Server failed to archive position.')
    );

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.archivePosition('pos-backend-1', 'Strategy exit');
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Server failed to archive position');

    // Position remains active and in activePositions
    expect(latestPortfolio?.activePositions.length).toBe(1);
    expect(latestPortfolio?.activePositions[0].status).toBe('ACTIVE');
    expect(latestPortfolio?.archivedPositions.length).toBe(0);
  });

  // 35. Handles HTTP 401 on position archive safely without falling back to demo records
  it('handles HTTP 401 on position archive safely without falling back to demo records', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    vi.spyOn(api, 'archivePortfolioPosition').mockRejectedValue(
      new AuthenticationError('Session expired.')
    );

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.archivePosition('pos-backend-1');
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Authentication required or session expired');
    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.portfolioError).toContain('Authentication required');
    expect(latestPortfolio?.activePositions.length).toBe(1);
    expect(latestPortfolio?.archivedPositions.length).toBe(0);
  });

  // 36. Rejects archiving if position is already archived
  it('rejects archiving if position is already archived', async () => {
    const alreadyArchived: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      status: 'ARCHIVED',
      archivedAt: '2026-10-20T12:00:00Z',
      archiveReason: 'Previously archived',
    };

    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [alreadyArchived],
    });

    await renderWithProviders();

    const archiveSpy = vi.spyOn(api, 'archivePortfolioPosition');

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.archivePosition('pos-backend-1');
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Position is already archived');
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  // 37. Preserves Demo Mode paper trading archive without making backend API calls
  it('preserves Demo Mode paper trading archive without making backend API calls', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(new AuthenticationError('Not authenticated'));
    await renderWithProviders();

    expect(latestPortfolio?.isDemoMode).toBe(true);
    const demoPos = latestPortfolio?.activePositions[0];
    expect(demoPos).toBeDefined();
    const initialActiveCount = latestPortfolio?.activePositions.length ?? 0;
    const initialArchivedCount = latestPortfolio?.archivedPositions.length ?? 0;

    const archiveSpy = vi.spyOn(api, 'archivePortfolioPosition');

    let archiveRes: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      archiveRes = await latestPortfolio?.archivePosition(demoPos!.id, 'Paper trading soft-archived');
    });

    expect(archiveRes?.success).toBe(true);
    expect(archiveSpy).not.toHaveBeenCalled();

    // Verify position moved from active to archived in Demo Mode
    expect(latestPortfolio?.activePositions.length).toBe(initialActiveCount - 1);
    expect(latestPortfolio?.archivedPositions.length).toBe(initialArchivedCount + 1);
    const archivedDemoPos = latestPortfolio?.archivedPositions.find((p) => p.id === demoPos!.id);
    expect(archivedDemoPos?.status).toBe('ARCHIVED');
    expect(archivedDemoPos?.archiveReason).toBe('Paper trading soft-archived');
  });

  // 38. ArchiveModal shows submitting state and prevents duplicate submissions while saving
  it('ArchiveModal shows submitting state and prevents duplicate submissions while saving', async () => {
    let confirmCalls = 0;
    let resolveConfirm: (val: { success: boolean; error?: string }) => void = () => {};
    const confirmPromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
      resolveConfirm = resolve;
    });

    const mockConfirmArchive = vi.fn().mockImplementation(() => {
      confirmCalls++;
      return confirmPromise;
    });

    const activePos: any = {
      id: 'pos-test-archive-1',
      symbol: 'INFY',
      companyName: 'Infosys Limited',
      status: 'ACTIVE',
      accumulatedQuantity: 50,
      totalCapitalDeployed: 95000,
      entries: [
        {
          id: 'entry-1',
          positionId: 'pos-test-archive-1',
          sequence: 1,
          entryType: 'INITIAL_ENTRY',
          entryDate: '2026-10-01',
          entryPrice: 1900.0,
          quantity: 50,
        },
      ],
      exit: null,
    };

    const modalContainer = new MockElement('div');
    const modalRoot = createRoot(modalContainer as unknown as HTMLElement);

    await act(async () => {
      modalRoot.render(
        <ArchiveModal
          position={activePos}
          isOpen={true}
          onClose={() => {}}
          onConfirmArchive={mockConfirmArchive}
        />
      );
    });

    const buttons = modalContainer.findAll((el) => el.tagName === 'BUTTON');
    const confirmBtn = buttons.find((btn) => btn.textContent.includes('Confirm Archive'));
    expect(confirmBtn).toBeDefined();

    // First click
    await act(async () => {
      simulateClick(confirmBtn!);
    });

    expect(confirmCalls).toBe(1);

    // Duplicate click while in-flight
    await act(async () => {
      simulateClick(confirmBtn!);
    });

    expect(confirmCalls).toBe(1);

    // Resolve
    await act(async () => {
      resolveConfirm({ success: true });
    });
  });

  // 39. Successful authenticated restore of unexited position transitions to ACTIVE
  it('restores an unexited archived position to ACTIVE status and refreshes portfolio', async () => {
    const archivedPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      id: 'pos-restore-active',
      status: 'ARCHIVED',
      archivedAt: '2026-10-24T18:00:00Z',
      archiveReason: 'Temporary archive',
      exit: null,
    };

    const restoredPos: PortfolioPositionResponse = {
      ...archivedPos,
      status: 'ACTIVE',
      archivedAt: null,
      archiveReason: null,
    };

    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const fetchSpy = vi.spyOn(api, 'fetchPortfolioPositions')
      .mockResolvedValueOnce({ positions: [archivedPos] })
      .mockResolvedValueOnce({ positions: [restoredPos] });

    await renderWithProviders();

    expect(latestPortfolio?.archivedPositions.length).toBe(1);
    expect(latestPortfolio?.activePositions.length).toBe(0);

    const restoreSpy = vi.spyOn(api, 'restorePortfolioPosition').mockResolvedValue(restoredPos);

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.restorePosition('pos-restore-active');
    });

    expect(result?.success).toBe(true);
    expect(result?.positionId).toBe('pos-restore-active');
    expect(restoreSpy).toHaveBeenCalledWith('pos-restore-active');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Moves out of archived into active list
    expect(latestPortfolio?.archivedPositions.length).toBe(0);
    expect(latestPortfolio?.activePositions.length).toBe(1);
    const active = latestPortfolio?.activePositions[0];
    expect(active?.status).toBe('ACTIVE');
    expect(active?.archivedAt).toBeNull();
    expect(active?.archiveReason).toBeNull();
    expect(active?.entries.length).toBe(1);
    expect(active?.entries[0].entryPrice).toBe(1520.5);
  });

  // 40. Successful authenticated restore of exited position transitions to COMPLETED
  it('restores an exited archived position to COMPLETED status and preserves exit/PnL history', async () => {
    const archivedExitedPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      id: 'pos-restore-completed',
      status: 'ARCHIVED',
      archivedAt: '2026-10-24T18:00:00Z',
      archiveReason: 'Archived closed trade',
      realizedPnl: 14925.0,
      exit: {
        id: 'exit-restore-1',
        positionId: 'pos-restore-completed',
        exitPrice: 1620.0,
        exitDate: '2026-10-20',
        recordedAt: '2026-10-20T15:30:00Z',
        notes: 'Target reached',
      },
    };

    const restoredCompletedPos: PortfolioPositionResponse = {
      ...archivedExitedPos,
      status: 'COMPLETED',
      archivedAt: null,
      archiveReason: null,
    };

    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    const fetchSpy = vi.spyOn(api, 'fetchPortfolioPositions')
      .mockResolvedValueOnce({ positions: [archivedExitedPos] })
      .mockResolvedValueOnce({ positions: [restoredCompletedPos] });

    await renderWithProviders();

    expect(latestPortfolio?.archivedPositions.length).toBe(1);

    const restoreSpy = vi.spyOn(api, 'restorePortfolioPosition').mockResolvedValue(restoredCompletedPos);

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.restorePosition('pos-restore-completed');
    });

    expect(result?.success).toBe(true);
    expect(result?.positionId).toBe('pos-restore-completed');
    expect(restoreSpy).toHaveBeenCalledWith('pos-restore-completed');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Moves out of archived into activePositions (which includes completed positions)
    expect(latestPortfolio?.archivedPositions.length).toBe(0);
    expect(latestPortfolio?.activePositions.length).toBe(1);
    const restored = latestPortfolio?.activePositions[0];
    expect(restored?.status).toBe('COMPLETED');
    expect(restored?.exit?.exitPrice).toBe(1620.0);
    expect(restored?.realizedPnl).toBe(14925.0);
    expect(restored?.archivedAt).toBeNull();
  });

  // 41. API failure on restore does not mutate local state
  it('does not mutate positions if restore API call returns an error', async () => {
    const archivedPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      id: 'pos-restore-err',
      status: 'ARCHIVED',
      archivedAt: '2026-10-24T18:00:00Z',
    };

    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [archivedPos],
    });

    await renderWithProviders();

    vi.spyOn(api, 'restorePortfolioPosition').mockRejectedValue(
      new ApiError(409, 'Cannot restore a position that is not archived.')
    );

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.restorePosition('pos-restore-err');
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Cannot restore a position that is not archived.');

    // State remains unmodified
    expect(latestPortfolio?.archivedPositions.length).toBe(1);
    expect(latestPortfolio?.archivedPositions[0].status).toBe('ARCHIVED');
    expect(latestPortfolio?.activePositions.length).toBe(0);
  });

  // 42. Network failure on restore does not mutate local state
  it('does not mutate positions if a network error occurs during restore', async () => {
    const archivedPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      id: 'pos-restore-net',
      status: 'ARCHIVED',
    };

    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [archivedPos],
    });

    await renderWithProviders();

    vi.spyOn(api, 'restorePortfolioPosition').mockRejectedValue(
      new NetworkError('Network request failed')
    );

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.restorePosition('pos-restore-net');
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Network request failed');
    expect(latestPortfolio?.archivedPositions.length).toBe(1);
  });

  // 43. HTTP 401 handling without demo fallback
  it('handles HTTP 401 on restore safely without falling back to demo records', async () => {
    const archivedPos: PortfolioPositionResponse = {
      ...sampleBackendPosition,
      id: 'pos-restore-401',
      status: 'ARCHIVED',
    };

    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [archivedPos],
    });

    await renderWithProviders();

    vi.spyOn(api, 'restorePortfolioPosition').mockRejectedValue(
      new AuthenticationError('Session expired.')
    );

    let result: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      result = await latestPortfolio?.restorePosition('pos-restore-401');
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Authentication required or session expired');
    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.portfolioError).toContain('Authentication required');
    expect(latestPortfolio?.archivedPositions.length).toBe(1);
  });

  // 44. Preserves Demo Mode paper trading restore without backend API calls
  it('preserves Demo Mode paper trading restore without making backend API calls', async () => {
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(new AuthenticationError('Not authenticated'));
    await renderWithProviders();

    expect(latestPortfolio?.isDemoMode).toBe(true);
    const demoArchived = latestPortfolio?.archivedPositions[0];
    expect(demoArchived).toBeDefined();

    const initialArchivedCount = latestPortfolio?.archivedPositions.length ?? 0;
    const initialActiveCount = latestPortfolio?.activePositions.length ?? 0;

    const restoreSpy = vi.spyOn(api, 'restorePortfolioPosition');

    let res: { success: boolean; positionId?: string; error?: string } | undefined;
    await act(async () => {
      res = await latestPortfolio?.restorePosition(demoArchived!.id);
    });

    expect(res?.success).toBe(true);
    expect(restoreSpy).not.toHaveBeenCalled();

    // Position moves from archived to active in demo mode
    expect(latestPortfolio?.archivedPositions.length).toBe(initialArchivedCount - 1);
    expect(latestPortfolio?.activePositions.length).toBe(initialActiveCount + 1);
    const restoredDemo = latestPortfolio?.activePositions.find((p) => p.id === demoArchived!.id);
    expect(restoredDemo?.status).toBe(demoArchived?.exit ? 'COMPLETED' : 'ACTIVE');
    expect(restoredDemo?.archivedAt).toBeUndefined();
    expect(restoredDemo?.archiveReason).toBeUndefined();
  });

  // 45. ArchivedView Restore button shows loading state and prevents duplicate submissions
  it('ArchivedView Restore button shows loading state and prevents duplicate clicks', async () => {
    let restoreCalls = 0;
    let resolveRestore: (val: { success: boolean; error?: string }) => void = () => {};
    const restorePromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
      resolveRestore = resolve;
    });

    const viewContainer = new MockElement('div');
    const viewRoot = createRoot(viewContainer as unknown as HTMLElement);

    const archivedItem: any = {
      ...sampleBackendPosition,
      id: 'arch-btn-test-1',
      symbol: 'TCS',
      companyName: 'Tata Consultancy Services',
      status: 'ARCHIVED',
      archivedAt: '2026-10-24T12:00:00Z',
      archiveReason: 'Profit booking',
      entries: [sampleBackendPosition.entries[0]],
      exit: null,
    };

    // Render with mock portfolio provider context
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [archivedItem],
    });

    await act(async () => {
      viewRoot.render(
        <AuthProvider>
          <PortfolioProvider>
            <ArchivedView />
          </PortfolioProvider>
        </AuthProvider>
      );
    });

    const buttons = viewContainer.findAll((el) => el.tagName === 'BUTTON');
    const restoreBtn = buttons.find((btn) => btn.textContent.includes('Restore to Portfolio'));
    expect(restoreBtn).toBeDefined();

    vi.spyOn(api, 'restorePortfolioPosition').mockImplementation(() => {
      restoreCalls++;
      return restorePromise as any;
    });

    // First click
    await act(async () => {
      simulateClick(restoreBtn!);
    });

    expect(restoreCalls).toBe(1);

    // Duplicate click while in-flight
    await act(async () => {
      simulateClick(restoreBtn!);
    });

    expect(restoreCalls).toBe(1);

    // Resolve
    await act(async () => {
      resolveRestore({ success: true });
    });
  });

  // 46. Full auth lifecycle: login transitions to authenticated mode, logout returns to demo mode cleanly without leaking records
  it('transitions from demo to authenticated mode on login, and reverts cleanly to demo mode on logout without leaking state', async () => {
    // Start unauthenticated
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(new AuthenticationError('Not authenticated'));
    const fetchPositionsSpy = vi.spyOn(api, 'fetchPortfolioPositions').mockResolvedValue({
      positions: [sampleBackendPosition],
    });

    await renderWithProviders();

    expect(latestAuth?.isAuthenticated).toBe(false);
    expect(latestPortfolio?.portfolioMode).toBe('demo');
    expect(latestPortfolio?.isDemoMode).toBe(true);
    expect(latestPortfolio?.activePositions.length).toBeGreaterThan(0);
    // Authenticated positions should not be fetched when unauthenticated in demo mode
    expect(fetchPositionsSpy).not.toHaveBeenCalled();

    // User logs in
    vi.spyOn(api, 'login').mockResolvedValue(mockUser);
    vi.spyOn(api, 'fetchCurrentUser').mockResolvedValue(mockUser);

    await act(async () => {
      await latestAuth?.login('trader@example.com', 'password123');
    });

    // Automatically transitions to Authenticated Mode and loads server positions
    expect(latestAuth?.isAuthenticated).toBe(true);
    expect(latestPortfolio?.portfolioMode).toBe('authenticated');
    expect(latestPortfolio?.isDemoMode).toBe(false);
    expect(fetchPositionsSpy).toHaveBeenCalled();
    expect(latestPortfolio?.activePositions.length).toBe(1);
    expect(latestPortfolio?.activePositions[0].symbol).toBe('HDFCBANK');

    // User logs out
    const logoutSpy = vi.spyOn(api, 'logout').mockResolvedValue({ status: 'ok' });

    await act(async () => {
      await latestAuth?.logout();
    });

    expect(logoutSpy).toHaveBeenCalledTimes(1);
    expect(latestAuth?.isAuthenticated).toBe(false);

    // Context must revert cleanly to Demo Mode with no leaking of authenticated records
    expect(latestPortfolio?.portfolioMode).toBe('demo');
    expect(latestPortfolio?.isDemoMode).toBe(true);
    expect(latestPortfolio?.portfolioError).toBeNull();
    // Reverts to demo positions, does not retain sampleBackendPosition
    expect(latestPortfolio?.activePositions.every((p) => p.id !== 'pos-backend-1')).toBe(true);
  });
});

