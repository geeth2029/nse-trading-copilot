import {
  createContext,
  useContext,
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  type FC,
  type ReactNode,
} from 'react';
import type {
  DashboardSummary,
  PortfolioPosition,
  PortfolioPositionCreatePayload,
  PyramidEntryCreatePayload,
  PositionExitCreatePayload,
  PositionArchivePayload,
  PyramidingEligibilityCheck,
  ScreenerStock,
  TradeActivityItem,
  TradeEntry,
  MarketSnapshotRead,
  InitialEntryOptions,
  PyramidEntryOptions,
} from '../types/trading';
import {
  MOCK_ACTIVE_POSITIONS,
  MOCK_ARCHIVED_POSITIONS,
  MOCK_RECENT_ACTIVITY,
} from '../data/mockPortfolio';
import { SAMPLE_NSE_STOCKS } from '../data/mockStocks';
import {
  calculateAccumulatedQuantity,
  calculateAverageEntryPrice,
  calculatePositionPnl,
  calculateTotalCapitalDeployed,
  calculateTradeSizing,
  evaluatePyramidingEligibility,
  validateExitData,
} from '../services/calculations';
import {
  fetchPortfolioPositions,
  createPortfolioPosition,
  addPyramidEntry as apiAddPyramidEntry,
  recordPositionExit as apiRecordPositionExit,
  archivePortfolioPosition as apiArchivePortfolioPosition,
  restorePortfolioPosition as apiRestorePortfolioPosition,
  ApiError,
  AuthenticationError,
  NetworkError,
} from '../services/api';
import { useAuth } from './AuthContext';

export type PortfolioMode = 'demo' | 'authenticated';

export interface PortfolioContextType {
  // Mode controls
  portfolioMode: PortfolioMode;
  setPortfolioMode: (mode: PortfolioMode) => void;
  isDemoMode: boolean;

  // Loading & error states
  isLoadingPortfolio: boolean;
  portfolioError: string | null;
  refreshPortfolio: () => Promise<void>;

  // Screener synchronization
  screenerQualifiedCount: number | null;
  setScreenerQualifiedCount: (count: number | null) => void;

  // Data views
  activePositions: PortfolioPosition[];
  archivedPositions: PortfolioPosition[];
  recentActivity: TradeActivityItem[];
  userCapital: number;
  setUserCapital: (capital: number) => void;
  summary: DashboardSummary;

  // Actions (functional in Demo Mode; addInitialEntry, addPyramidEntry, and recordPositionExit connected in Authenticated Mode)
  addInitialEntry: (
    stockOrSnapshot: ScreenerStock | MarketSnapshotRead,
    capital: number,
    customStopLossOrNotes?: number | string | InitialEntryOptions,
    options?: InitialEntryOptions
  ) => Promise<{ success: boolean; positionId?: string; error?: string }>;
  addPyramidEntry: (
    positionId: string,
    capital: number,
    notesOrOptions?: string | PyramidEntryOptions,
    options?: PyramidEntryOptions
  ) => Promise<{ success: boolean; positionId?: string; error?: string }>;
  recordPositionExit: (
    positionId: string,
    exitPrice: number,
    exitDate: string,
    notes?: string
  ) => Promise<{ success: boolean; positionId?: string; error?: string }>;
  archivePosition: (
    positionId: string,
    reason?: string
  ) => Promise<{ success: boolean; positionId?: string; error?: string }>;
  restorePosition: (
    positionId: string
  ) => Promise<{ success: boolean; positionId?: string; error?: string }>;
  checkPyramidEligibility: (
    position: PortfolioPosition
  ) => PyramidingEligibilityCheck | null;
}

// eslint-disable-next-line react/only-export-components
// oxlint-disable-next-line react/only-export-components
export const PortfolioContext = createContext<PortfolioContextType | undefined>(undefined);

export const PortfolioProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuth();

  const [portfolioMode, setPortfolioModeState] = useState<PortfolioMode>('demo');
  const [demoActivePositions, setDemoActivePositions] = useState<PortfolioPosition[]>(MOCK_ACTIVE_POSITIONS);
  const [demoArchivedPositions, setDemoArchivedPositions] = useState<PortfolioPosition[]>(MOCK_ARCHIVED_POSITIONS);
  const [demoActivity, setDemoActivity] = useState<TradeActivityItem[]>(MOCK_RECENT_ACTIVITY);
  const [userCapital, setUserCapital] = useState<number>(500000);

  const [authenticatedPositions, setAuthenticatedPositions] = useState<PortfolioPosition[]>([]);
  const [isLoadingPortfolio, setIsLoadingPortfolio] = useState<boolean>(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);

  const [authenticatedQualifiedCount, setAuthenticatedQualifiedCount] = useState<number | null>(null);

  const setScreenerQualifiedCount = useCallback((count: number | null) => {
    setAuthenticatedQualifiedCount(count);
  }, []);

  const isMountedRef = useRef<boolean>(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const setPortfolioMode = useCallback((mode: PortfolioMode) => {
    if (mode === 'authenticated' && !isAuthenticated) {
      setPortfolioModeState('demo');
      return;
    }
    setPortfolioModeState(mode);
  }, [isAuthenticated]);

  const loadAuthenticatedPositions = useCallback(async () => {
    if (!isAuthenticated) {
      setAuthenticatedPositions([]);
      setIsLoadingPortfolio(false);
      return;
    }

    setIsLoadingPortfolio(true);
    setPortfolioError(null);

    try {
      const response = await fetchPortfolioPositions();
      if (!isMountedRef.current) return;
      // Do not convert null to zero! Preserves exact backend response
      setAuthenticatedPositions(response.positions);
      setPortfolioError(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      // Critical: never display demo positions as if they were saved user positions
      setAuthenticatedPositions([]);

      if (err instanceof AuthenticationError) {
        setPortfolioError('Authentication required or session expired. Please sign in again.');
      } else if (err instanceof NetworkError) {
        setPortfolioError(err.message || 'Unable to connect to the portfolio service.');
      } else if (err instanceof ApiError) {
        setPortfolioError(err.message || `Failed to fetch portfolio (status ${err.status}).`);
      } else {
        setPortfolioError('An unexpected error occurred while loading your portfolio.');
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoadingPortfolio(false);
      }
    }
  }, [isAuthenticated]);

  const refreshPortfolio = useCallback(async () => {
    await loadAuthenticatedPositions();
  }, [loadAuthenticatedPositions]);

  // Handle authentication lifecycle transitions
  const prevAuthRef = useRef<boolean>(isAuthenticated);
  useEffect(() => {
    if (!prevAuthRef.current && isAuthenticated) {
      // User signed in: default to Authenticated Portfolio Mode and load positions
      setPortfolioModeState('authenticated');
    } else if (prevAuthRef.current && !isAuthenticated) {
      // User signed out: revert to Demo Mode and clear authenticated records
      setPortfolioModeState('demo');
      setAuthenticatedPositions([]);
      setAuthenticatedQualifiedCount(null);
      setPortfolioError(null);
    }
    prevAuthRef.current = isAuthenticated;
  }, [isAuthenticated]);

  // Load authenticated positions whenever entering Authenticated Mode
  useEffect(() => {
    let cancelled = false;
    if (isAuthenticated && portfolioMode === 'authenticated') {
      queueMicrotask(() => {
        if (!cancelled && isMountedRef.current) {
          void loadAuthenticatedPositions();
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, portfolioMode, loadAuthenticatedPositions]);

  const isDemoMode = portfolioMode === 'demo';

  const screenerQualifiedCount = isDemoMode
    ? SAMPLE_NSE_STOCKS.filter((s) => s.isEligible).length
    : authenticatedQualifiedCount;

  // Build authenticated recent activity derived from server positions
  const authenticatedActivity = useMemo<TradeActivityItem[]>(() => {
    const items: TradeActivityItem[] = [];
    for (const pos of authenticatedPositions) {
      for (const entry of pos.entries) {
        items.push({
          id: `act-entry-${entry.id}`,
          symbol: pos.symbol,
          companyName: pos.companyName,
          type: entry.entryType,
          date: entry.entryDate,
          price: entry.entryPrice,
          stopLoss: entry.stopLoss,
          quantity: entry.quantity,
          status: entry.sizingStatus,
          pnl: entry.entryPnl,
          notes: entry.notes || undefined,
        });
      }
      if (pos.exit) {
        items.push({
          id: `act-exit-${pos.id}`,
          symbol: pos.symbol,
          companyName: pos.companyName,
          type: 'POSITION_EXIT',
          date: pos.exit.exitDate,
          price: pos.exit.exitPrice,
          stopLoss: null,
          quantity: pos.accumulatedQuantity,
          status: 'VALID',
          pnl: pos.realizedPnl,
          notes: pos.exit.notes || undefined,
        });
      }
    }
    return items.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  }, [authenticatedPositions]);

  const activePositions = useMemo(() => {
    if (isDemoMode) {
      return demoActivePositions;
    }
    return authenticatedPositions.filter((p) => p.status !== 'ARCHIVED');
  }, [isDemoMode, demoActivePositions, authenticatedPositions]);

  const archivedPositions = useMemo(() => {
    if (isDemoMode) {
      return demoArchivedPositions;
    }
    return authenticatedPositions.filter((p) => p.status === 'ARCHIVED');
  }, [isDemoMode, demoArchivedPositions, authenticatedPositions]);

  const recentActivity = useMemo(() => {
    if (isDemoMode) {
      return demoActivity;
    }
    return authenticatedActivity;
  }, [isDemoMode, demoActivity, authenticatedActivity]);

  /**
   * Evaluates pyramiding eligibility against the latest entry row
   */
  const checkPyramidEligibility = (position: PortfolioPosition): PyramidingEligibilityCheck | null => {
    if (!position.entries || position.entries.length === 0) return null;
    const lastEntry = position.entries[position.entries.length - 1];
    const stockSnapshot = isDemoMode ? SAMPLE_NSE_STOCKS.find((s) => s.symbol === position.symbol) : undefined;
    const weeklyRsi = stockSnapshot ? stockSnapshot.weeklyRsi : position.latestWeeklyRsi;
    const twentyWeekSma = stockSnapshot ? stockSnapshot.twentyWeekSma : position.twentyWeekSmaStopLoss;

    if (weeklyRsi === null || twentyWeekSma === null || weeklyRsi === undefined || twentyWeekSma === undefined) {
      return null;
    }

    return evaluatePyramidingEligibility(weeklyRsi, twentyWeekSma, lastEntry.entryPrice);
  };

  /**
   * Initial Entry Workflow
   */
  /**
   * Initial Entry Workflow
   */
  const addInitialEntry = async (
    stockOrSnapshot: ScreenerStock | MarketSnapshotRead,
    capital: number,
    customStopLossOrNotes?: number | string | InitialEntryOptions,
    options?: InitialEntryOptions
  ): Promise<{ success: boolean; positionId?: string; error?: string }> => {
    let customStopLoss: number | undefined;
    let notes: string | undefined;
    let resolvedOptions: InitialEntryOptions | undefined;

    if (typeof customStopLossOrNotes === 'number') {
      customStopLoss = customStopLossOrNotes;
      resolvedOptions = options;
    } else if (typeof customStopLossOrNotes === 'string') {
      notes = customStopLossOrNotes;
      resolvedOptions = options;
    } else if (customStopLossOrNotes && typeof customStopLossOrNotes === 'object') {
      resolvedOptions = customStopLossOrNotes;
    } else {
      resolvedOptions = options;
    }

    if (resolvedOptions?.notes) {
      notes = resolvedOptions.notes;
    }

    const executionPrice = resolvedOptions?.executionPrice ?? null;
    const confirmReferencePriceAsExecution = resolvedOptions?.confirmReferencePriceAsExecution ?? false;
    const acknowledgeInvalidRps = resolvedOptions?.acknowledgeInvalidRps ?? false;

    const isScreenerStock = 'referencePrice' in stockOrSnapshot;
    const refPrice = isScreenerStock ? stockOrSnapshot.referencePrice : stockOrSnapshot.lastPrice;
    const defaultSma = isScreenerStock ? stockOrSnapshot.twentyWeekSma : (stockOrSnapshot.twentyWeekSma ?? refPrice);
    const stopLossToUse = customStopLoss ?? defaultSma;
    const weeklyRsi = isScreenerStock ? stockOrSnapshot.weeklyRsi : (stockOrSnapshot.weeklyRsi ?? 50);
    const displayName = isScreenerStock ? stockOrSnapshot.displayName : stockOrSnapshot.symbol;

    if (isDemoMode) {
      let effectiveEntryPrice = refPrice;
      if (executionPrice !== null && executionPrice !== undefined) {
        if (executionPrice <= 0 || isNaN(Number(executionPrice))) {
          return { success: false, error: 'Execution price must be a positive number.' };
        }
        effectiveEntryPrice = Number(executionPrice);
      }

      const sizing = calculateTradeSizing({
        userCapital: capital,
        referencePrice: effectiveEntryPrice,
        twentyWeekSma: stopLossToUse,
      });

      if (sizing.sizingStatus === 'INVALID_RPS_WARNING' && !acknowledgeInvalidRps) {
        return {
          success: false,
          error: 'Stop-loss is at or above entry price. Non-positive risk per share must be explicitly acknowledged.',
        };
      }

      if (sizing.sizingStatus !== 'INVALID_RPS_WARNING' && (!sizing.quantity || sizing.quantity <= 0)) {
        return {
          success: false,
          error: 'Calculated quantity is 0 shares. Insufficient capital to open position with 1% risk budget.',
        };
      }

      const existingActive = demoActivePositions.find(
        (p) => p.symbol === stockOrSnapshot.symbol && p.status !== 'ARCHIVED'
      );
      if (existingActive) {
        return {
          success: false,
          error: `An active position already exists for ${stockOrSnapshot.symbol}. To add another entry, use the Pyramid action on the Portfolio page.`,
        };
      }

      const positionId = `pos-${Date.now()}`;
      const today = new Date().toISOString().split('T')[0];

      const initialEntry: TradeEntry = {
        id: `entry-${Date.now()}`,
        positionId,
        sequence: 1,
        entryType: 'INITIAL_ENTRY',
        entryDate: today,
        entryPrice: effectiveEntryPrice,
        stopLoss: stopLossToUse,
        rps: sizing.rps,
        rpt: sizing.rpt,
        quantity: sizing.quantity,
        capitalSnapshot: capital,
        sizingStatus: sizing.sizingStatus,
        notes: notes || `Initial entry sized at 1% RPT (₹${sizing.rpt.toFixed(2)}) with RPS ₹${sizing.rps.toFixed(2)}`,
      };

      const isPyramidEligible = evaluatePyramidingEligibility(
        weeklyRsi,
        defaultSma,
        effectiveEntryPrice
      ).isEligible;

      const newPosition: PortfolioPosition = {
        id: positionId,
        symbol: stockOrSnapshot.symbol,
        companyName: displayName,
        status: 'ACTIVE',
        initialEntryDate: today,
        entries: [initialEntry],
        accumulatedQuantity: sizing.quantity || 0,
        averageEntryPrice: sizing.quantity ? effectiveEntryPrice : null,
        totalCapitalDeployed: sizing.capitalRequired || 0,
        currentReferencePrice: refPrice,
        twentyWeekSmaStopLoss: defaultSma,
        latestWeeklyRsi: weeklyRsi,
        isPyramidEligible,
        unrealizedPnl: 0,
      };

      setDemoActivePositions((prev) => [newPosition, ...prev]);

      const newActivity: TradeActivityItem = {
        id: `act-${Date.now()}`,
        symbol: stockOrSnapshot.symbol,
        companyName: displayName,
        type: 'INITIAL_ENTRY',
        date: today,
        price: effectiveEntryPrice,
        stopLoss: stopLossToUse,
        quantity: sizing.quantity,
        status: sizing.sizingStatus,
        notes: sizing.warningMessage || `Initial position opened with ₹${sizing.rpt.toFixed(2)} risk budget`,
      };
      setDemoActivity((prev) => [newActivity, ...prev]);

      return { success: true, positionId };
    }

    // Authenticated Portfolio Mode — prevent sample or unverified market data from being persisted
    if ('dataSource' in stockOrSnapshot && stockOrSnapshot.dataSource === 'Sample NSE Fixture (Demo)') {
      return {
        success: false,
        error:
          'Authenticated entry creation is temporarily unavailable because verified NSE market data has not been connected.',
      };
    }

    const existingActive = authenticatedPositions.find(
      (p) => p.symbol === stockOrSnapshot.symbol && p.status === 'ACTIVE'
    );
    if (existingActive) {
      return {
        success: false,
        error: `An active position already exists for ${stockOrSnapshot.symbol}. To add another entry, use the Pyramid action on the Portfolio page.`,
      };
    }

    const payload: PortfolioPositionCreatePayload = {
      symbol: stockOrSnapshot.symbol,
      capital,
      notes,
    };
    if (executionPrice !== null && executionPrice !== undefined) {
      payload.execution_price = executionPrice;
      payload.executionPrice = executionPrice;
    }
    if (confirmReferencePriceAsExecution) {
      payload.confirm_reference_price_as_execution = true;
      payload.confirmReferencePriceAsExecution = true;
    }
    if (acknowledgeInvalidRps) {
      payload.acknowledge_invalid_rps = true;
      payload.acknowledgeInvalidRps = true;
    }

    try {
      const created = await createPortfolioPosition(payload);
      // Refresh authenticated portfolio to synchronize server-returned position and activities
      await refreshPortfolio();
      return { success: true, positionId: created.id };
    } catch (err: unknown) {
      if (err instanceof AuthenticationError) {
        setPortfolioError('Authentication required or session expired. Please sign in again.');
        return {
          success: false,
          error: 'Authentication required or session expired. Please sign in again.',
        };
      }
      if (err instanceof ApiError) {
        return {
          success: false,
          error: err.message || `API error (${err.status})`,
        };
      }
      if (err instanceof NetworkError) {
        return {
          success: false,
          error: err.message || 'Network error occurred while creating position.',
        };
      }
      const errorMsg = err instanceof Error ? err.message : 'Failed to create position on server.';
      return {
        success: false,
        error: errorMsg,
      };
    }
  };

  /**
   * Pyramiding Workflow
   */
  const addPyramidEntry = async (
    positionId: string,
    capital: number,
    notesOrOptions?: string | PyramidEntryOptions,
    options?: PyramidEntryOptions
  ): Promise<{ success: boolean; positionId?: string; error?: string }> => {
    let notes: string | undefined;
    let resolvedOptions: PyramidEntryOptions | undefined;

    if (typeof notesOrOptions === 'string') {
      notes = notesOrOptions;
      resolvedOptions = options;
    } else if (notesOrOptions && typeof notesOrOptions === 'object') {
      resolvedOptions = notesOrOptions;
    } else {
      resolvedOptions = options;
    }

    if (resolvedOptions?.notes) {
      notes = resolvedOptions.notes;
    }

    const executionPrice = resolvedOptions?.executionPrice ?? null;
    const confirmReferencePriceAsExecution = resolvedOptions?.confirmReferencePriceAsExecution ?? false;
    const acknowledgeInvalidRps = resolvedOptions?.acknowledgeInvalidRps ?? false;

    if (isDemoMode) {
      const positionIndex = demoActivePositions.findIndex((p) => p.id === positionId);
      if (positionIndex === -1) {
        return { success: false, error: 'Position not found in active portfolio.' };
      }

      const position = demoActivePositions[positionIndex];
      if (position.exit) {
        return { success: false, error: 'Cannot pyramid an exited position.' };
      }

      const lastEntry = position.entries[position.entries.length - 1];
      const stockSnapshot = SAMPLE_NSE_STOCKS.find((s) => s.symbol === position.symbol);
      const refPrice = stockSnapshot ? stockSnapshot.referencePrice : (position.currentReferencePrice ?? 0);
      const currentSma = stockSnapshot ? stockSnapshot.twentyWeekSma : (position.twentyWeekSmaStopLoss ?? 0);
      const weeklyRsi = stockSnapshot ? stockSnapshot.weeklyRsi : (position.latestWeeklyRsi ?? 0);

      const pCheck = evaluatePyramidingEligibility(weeklyRsi, currentSma, lastEntry.entryPrice);
      if (!pCheck.isEligible) {
        return {
          success: false,
          error: `Pyramiding eligibility failed: ${pCheck.reasons.join(' • ')}`,
        };
      }

      let effectiveEntryPrice = refPrice;
      if (executionPrice !== null && executionPrice !== undefined) {
        if (executionPrice <= 0 || isNaN(Number(executionPrice))) {
          return { success: false, error: 'Execution price must be a positive number.' };
        }
        effectiveEntryPrice = Number(executionPrice);
      }

      const sizing = calculateTradeSizing({
        userCapital: capital,
        referencePrice: effectiveEntryPrice,
        twentyWeekSma: currentSma,
      });

      const today = new Date().toISOString().split('T')[0];
      const newEntry: TradeEntry = {
        id: `entry-${Date.now()}`,
        positionId,
        sequence: position.entries.length + 1,
        entryType: 'PYRAMID_ENTRY',
        entryDate: today,
        entryPrice: effectiveEntryPrice,
        stopLoss: currentSma,
        rps: sizing.rps,
        rpt: sizing.rpt,
        quantity: sizing.quantity,
        capitalSnapshot: capital,
        sizingStatus: sizing.sizingStatus,
        notes: notes || `Pyramid #${position.entries.length}: RSI ${weeklyRsi.toFixed(1)} > 60 and SMA ₹${currentSma.toFixed(2)} in range`,
      };

      const updatedEntries = [...position.entries, newEntry];
      const updatedAccumulatedQty = calculateAccumulatedQuantity(updatedEntries);
      const updatedAvgPrice = calculateAverageEntryPrice(updatedEntries);
      const updatedTotalCapital = calculateTotalCapitalDeployed(updatedEntries);
      const unrealizedPnl = Number(
        ((refPrice - (updatedAvgPrice ?? refPrice)) * updatedAccumulatedQty).toFixed(2)
      );

      const nextCheck = evaluatePyramidingEligibility(weeklyRsi, currentSma, effectiveEntryPrice);

      const updatedPosition: PortfolioPosition = {
        ...position,
        entries: updatedEntries,
        accumulatedQuantity: updatedAccumulatedQty,
        averageEntryPrice: updatedAvgPrice,
        totalCapitalDeployed: updatedTotalCapital,
        currentReferencePrice: refPrice,
        twentyWeekSmaStopLoss: currentSma,
        latestWeeklyRsi: weeklyRsi,
        isPyramidEligible: nextCheck.isEligible,
        pyramidCheck: nextCheck,
        unrealizedPnl,
      };

      setDemoActivePositions((prev) => {
        const copy = [...prev];
        copy[positionIndex] = updatedPosition;
        return copy;
      });

      const newActivity: TradeActivityItem = {
        id: `act-${Date.now()}`,
        symbol: position.symbol,
        companyName: position.companyName,
        type: 'PYRAMID_ENTRY',
        date: today,
        price: effectiveEntryPrice,
        stopLoss: currentSma,
        quantity: sizing.quantity,
        status: sizing.sizingStatus,
        notes: `Pyramid #${position.entries.length} added. New total: ${updatedAccumulatedQty} shares.`,
      };
      setDemoActivity((prev) => [newActivity, ...prev]);

      return { success: true };
    }

    // Authenticated Portfolio Mode
    const position = authenticatedPositions.find((p) => p.id === positionId);
    if (!position) {
      return { success: false, error: 'Position not found in authenticated portfolio.' };
    }

    if (position.status !== 'ACTIVE' || position.exit) {
      return { success: false, error: 'Cannot add pyramid entries to an exited or archived position.' };
    }

    // Reject missing technical market data to prevent unsafe calculations
    const refPrice = position.currentReferencePrice;
    const currentSma = position.twentyWeekSmaStopLoss;
    const weeklyRsi = position.latestWeeklyRsi;

    if (
      refPrice === null ||
      currentSma === null ||
      weeklyRsi === null ||
      refPrice === undefined ||
      currentSma === undefined ||
      weeklyRsi === undefined ||
      refPrice <= 0 ||
      currentSma <= 0
    ) {
      return {
        success: false,
        error: 'Live technical market data (reference price, 20-week SMA, or weekly RSI) is unavailable for this position.',
      };
    }

    // Strict Pyramiding Eligibility Check:
    // 1. Weekly RSI > 60.0 (strictly greater)
    // 2. Previous Entry Price <= 20-week SMA <= Previous Entry Price + 3
    const lastEntry = position.entries[position.entries.length - 1];
    const pCheck = evaluatePyramidingEligibility(weeklyRsi, currentSma, lastEntry.entryPrice);
    if (!pCheck.isEligible) {
      return {
        success: false,
        error: `Pyramiding eligibility failed: ${pCheck.reasons.join(' • ')}`,
      };
    }

    const payload: PyramidEntryCreatePayload = {
      capital,
      notes: notes || undefined,
    };
    if (executionPrice !== null && executionPrice !== undefined) {
      payload.execution_price = executionPrice;
      payload.executionPrice = executionPrice;
    }
    if (confirmReferencePriceAsExecution) {
      payload.confirm_reference_price_as_execution = true;
      payload.confirmReferencePriceAsExecution = true;
    }
    if (acknowledgeInvalidRps) {
      payload.acknowledge_invalid_rps = true;
      payload.acknowledgeInvalidRps = true;
    }

    try {
      const updated = await apiAddPyramidEntry(positionId, payload);
      // Refresh authenticated portfolio to synchronize server-returned position and activities
      await refreshPortfolio();
      return { success: true, positionId: updated.id };
    } catch (err: unknown) {
      if (err instanceof AuthenticationError) {
        setPortfolioError('Authentication required or session expired. Please sign in again.');
        return {
          success: false,
          error: 'Authentication required or session expired. Please sign in again.',
        };
      }
      if (err instanceof ApiError) {
        return {
          success: false,
          error: err.message || `API error (${err.status})`,
        };
      }
      if (err instanceof NetworkError) {
        return {
          success: false,
          error: err.message || 'Network error occurred while recording pyramid entry.',
        };
      }
      const errorMsg = err instanceof Error ? err.message : 'Failed to record pyramid entry on server.';
      return {
        success: false,
        error: errorMsg,
      };
    }
  };

  /**
   * Position Exit Workflow
   */
  const recordPositionExit = async (
    positionId: string,
    exitPrice: number,
    exitDate: string,
    notes?: string
  ): Promise<{ success: boolean; positionId?: string; error?: string }> => {
    if (isDemoMode) {
      const validation = validateExitData(exitPrice, exitDate);
      if (!validation.isValid) {
        return { success: false, error: validation.error };
      }

      const positionIndex = demoActivePositions.findIndex((p) => p.id === positionId);
      if (positionIndex === -1) {
        return { success: false, error: 'Position not found in active portfolio.' };
      }

      const position = demoActivePositions[positionIndex];
      if (position.exit) {
        return { success: false, error: 'Position has already been exited.' };
      }

      const { entryPnls, totalPnl } = calculatePositionPnl(position.entries, exitPrice);

      const recordedAt = new Date().toISOString();
      const updatedEntries = position.entries.map((entry, idx) => ({
        ...entry,
        entryPnl: entryPnls[idx] !== null ? entryPnls[idx] : undefined,
      }));

      const updatedPosition: PortfolioPosition = {
        ...position,
        status: 'COMPLETED',
        entries: updatedEntries,
        exit: {
          id: `exit-${Date.now()}`,
          positionId,
          exitPrice,
          exitDate,
          recordedAt,
          notes,
        },
        realizedPnl: totalPnl,
        unrealizedPnl: 0,
        isPyramidEligible: false,
      };

      setDemoActivePositions((prev) => {
        const copy = [...prev];
        copy[positionIndex] = updatedPosition;
        return copy;
      });

      const newActivity: TradeActivityItem = {
        id: `act-${Date.now()}`,
        symbol: position.symbol,
        companyName: position.companyName,
        type: 'POSITION_EXIT',
        date: exitDate,
        price: exitPrice,
        stopLoss: position.twentyWeekSmaStopLoss,
        quantity: position.accumulatedQuantity,
        status: 'VALID',
        pnl: totalPnl,
        notes: notes || `Position closed at ₹${exitPrice.toFixed(2)}. Gross P&L: ₹${totalPnl?.toFixed(2) || '0.00'}.`,
      };
      setDemoActivity((prev) => [newActivity, ...prev]);

      return { success: true };
    }

    // Authenticated Portfolio Mode
    const position = authenticatedPositions.find((p) => p.id === positionId);
    if (!position) {
      return { success: false, error: 'Position not found in authenticated portfolio.' };
    }

    if (position.exit || position.status === 'COMPLETED') {
      return { success: false, error: 'An exit has already been recorded for this position.' };
    }

    if (position.status === 'ARCHIVED') {
      return { success: false, error: 'Cannot record an exit on an archived position.' };
    }

    const validation = validateExitData(exitPrice, exitDate);
    if (!validation.isValid) {
      return { success: false, error: validation.error };
    }

    if (position.initialEntryDate && exitDate < position.initialEntryDate) {
      return { success: false, error: 'Exit date cannot precede initial entry date.' };
    }

    const payload: PositionExitCreatePayload = {
      exitPrice,
      exitDate,
      notes: notes?.trim() ? notes.trim() : undefined,
    };

    try {
      const updated = await apiRecordPositionExit(positionId, payload);
      await refreshPortfolio();
      return { success: true, positionId: updated.id };
    } catch (err: unknown) {
      if (err instanceof AuthenticationError) {
        setPortfolioError('Authentication required or session expired. Please sign in again.');
        return {
          success: false,
          error: 'Authentication required or session expired. Please sign in again.',
        };
      }
      if (err instanceof ApiError) {
        return {
          success: false,
          error: err.message || `API error (${err.status})`,
        };
      }
      if (err instanceof NetworkError) {
        return {
          success: false,
          error: err.message || 'Network error occurred while recording position exit.',
        };
      }
      const errorMsg = err instanceof Error ? err.message : 'Failed to record position exit on server.';
      return {
        success: false,
        error: errorMsg,
      };
    }
  };

  /**
   * Archiving Workflow
   */
  const archivePosition = async (
    positionId: string,
    reason?: string
  ): Promise<{ success: boolean; positionId?: string; error?: string }> => {
    if (isDemoMode) {
      const position = demoActivePositions.find((p) => p.id === positionId);
      if (!position) {
        return { success: false, error: 'Position not found in active portfolio.' };
      }

      const archivedAt = new Date().toISOString();
      const archivedItem: PortfolioPosition = {
        ...position,
        status: 'ARCHIVED',
        archivedAt,
        archiveReason: reason || 'Soft-archived by trader; trading history preserved.',
      };

      setDemoActivePositions((prev) => prev.filter((p) => p.id !== positionId));
      setDemoArchivedPositions((prev) => [archivedItem, ...prev]);

      return { success: true };
    }

    // Authenticated Portfolio Mode
    const position = authenticatedPositions.find((p) => p.id === positionId);
    if (!position) {
      return { success: false, error: 'Position not found in authenticated portfolio.' };
    }

    if (position.status === 'ARCHIVED') {
      return { success: false, error: 'Position is already archived.' };
    }

    const payload: PositionArchivePayload = {
      reason: reason?.trim() ? reason.trim() : undefined,
    };

    try {
      const updated = await apiArchivePortfolioPosition(positionId, payload);
      await refreshPortfolio();
      return { success: true, positionId: updated.id };
    } catch (err: unknown) {
      if (err instanceof AuthenticationError) {
        setPortfolioError('Authentication required or session expired. Please sign in again.');
        return {
          success: false,
          error: 'Authentication required or session expired. Please sign in again.',
        };
      }
      if (err instanceof ApiError) {
        return {
          success: false,
          error: err.message || `API error (${err.status})`,
        };
      }
      if (err instanceof NetworkError) {
        return {
          success: false,
          error: err.message || 'Network error occurred while archiving position.',
        };
      }
      const errorMsg = err instanceof Error ? err.message : 'Failed to archive position on server.';
      return {
        success: false,
        error: errorMsg,
      };
    }
  };

  /**
   * Restore Workflow
   */
  const restorePosition = async (
    positionId: string
  ): Promise<{ success: boolean; positionId?: string; error?: string }> => {
    if (isDemoMode) {
      const position = demoArchivedPositions.find((p) => p.id === positionId);
      if (!position) {
        return { success: false, error: 'Archived position not found.' };
      }

      const restoredItem: PortfolioPosition = {
        ...position,
        status: position.exit ? 'COMPLETED' : 'ACTIVE',
        archivedAt: undefined,
        archiveReason: undefined,
      };

      setDemoArchivedPositions((prev) => prev.filter((p) => p.id !== positionId));
      setDemoActivePositions((prev) => [restoredItem, ...prev]);

      return { success: true, positionId };
    }

    // Authenticated Portfolio Mode
    const position = authenticatedPositions.find((p) => p.id === positionId);
    if (!position) {
      return { success: false, error: 'Position not found in authenticated portfolio.' };
    }

    if (position.status !== 'ARCHIVED') {
      return { success: false, error: 'Position is not archived.' };
    }

    try {
      const updated = await apiRestorePortfolioPosition(positionId);
      await refreshPortfolio();
      return { success: true, positionId: updated.id };
    } catch (err: unknown) {
      if (err instanceof AuthenticationError) {
        setPortfolioError('Authentication required or session expired. Please sign in again.');
        return {
          success: false,
          error: 'Authentication required or session expired. Please sign in again.',
        };
      }
      if (err instanceof ApiError) {
        return {
          success: false,
          error: err.message || `API error (${err.status})`,
        };
      }
      if (err instanceof NetworkError) {
        return {
          success: false,
          error: err.message || 'Network error occurred while restoring position.',
        };
      }
      const errorMsg = err instanceof Error ? err.message : 'Failed to restore position on server.';
      return {
        success: false,
        error: errorMsg,
      };
    }
  };

  /**
   * Derived summaries
   */
  const demoSummary = useMemo<DashboardSummary>(() => {
    const activeOnly = demoActivePositions.filter((p) => p.status === 'ACTIVE');
    const totalQty = activeOnly.reduce((acc, p) => acc + p.accumulatedQuantity, 0);
    const totalCapital = activeOnly.reduce((acc, p) => acc + p.totalCapitalDeployed, 0);

    const realizedActive = demoActivePositions.reduce((acc, p) => (p.realizedPnl ? acc + p.realizedPnl : acc), 0);
    const realizedArchived = demoArchivedPositions.reduce((acc, p) => (p.realizedPnl ? acc + p.realizedPnl : acc), 0);
    const totalRealizedPnl = Number((realizedActive + realizedArchived).toFixed(2));

    const realizedPercent = totalCapital > 0 ? Number(((totalRealizedPnl / totalCapital) * 100).toFixed(1)) : 12.8;

    return {
      activePositionsCount: activeOnly.length,
      totalQuantity: totalQty,
      realizedPnl: totalRealizedPnl,
      realizedPnlPercent: realizedPercent,
      archivedPositionsCount: demoArchivedPositions.length,
      totalCapitalDeployed: totalCapital,
      dataStatus: 'SAMPLE_DATA',
      asOfTimestamp: '2026-10-23 15:30:00 IST',
    };
  }, [demoActivePositions, demoArchivedPositions]);

  const authenticatedSummary = useMemo<DashboardSummary>(() => {
    const activeOnly = authenticatedPositions.filter((p) => p.status === 'ACTIVE');
    const archivedOnly = authenticatedPositions.filter((p) => p.status === 'ARCHIVED');
    const totalQty = activeOnly.reduce((acc, p) => acc + p.accumulatedQuantity, 0);
    const totalCapital = activeOnly.reduce((acc, p) => acc + p.totalCapitalDeployed, 0);

    // Sum realized P&L only where not null
    const totalRealizedPnl = Number(
      authenticatedPositions
        .reduce((acc, p) => (p.realizedPnl !== null && p.realizedPnl !== undefined ? acc + p.realizedPnl : acc), 0)
        .toFixed(2)
    );

    const realizedPercent =
      totalCapital > 0 ? Number(((totalRealizedPnl / totalCapital) * 100).toFixed(1)) : 0;

    return {
      activePositionsCount: activeOnly.length,
      totalQuantity: totalQty,
      realizedPnl: totalRealizedPnl,
      realizedPnlPercent: realizedPercent,
      archivedPositionsCount: archivedOnly.length,
      totalCapitalDeployed: totalCapital,
      dataStatus: 'LIVE_SIMULATION',
      asOfTimestamp: 'Authenticated Session',
    };
  }, [authenticatedPositions]);

  const summary = isDemoMode ? demoSummary : authenticatedSummary;

  return (
    <PortfolioContext.Provider
      value={{
        portfolioMode,
        setPortfolioMode,
        isDemoMode,
        isLoadingPortfolio,
        portfolioError,
        refreshPortfolio,
        screenerQualifiedCount,
        setScreenerQualifiedCount,
        activePositions,
        archivedPositions,
        recentActivity,
        userCapital,
        setUserCapital,
        summary,
        addInitialEntry,
        addPyramidEntry,
        recordPositionExit,
        archivePosition,
        restorePosition,
        checkPyramidEligibility,
      }}
    >
      {children}
    </PortfolioContext.Provider>
  );
};

// eslint-disable-next-line react/only-export-components
// oxlint-disable-next-line react/only-export-components
export const usePortfolio = (): PortfolioContextType => {
  const context = useContext(PortfolioContext);
  if (!context) {
    throw new Error('usePortfolio must be used within a PortfolioProvider');
  }
  return context;
};

// eslint-disable-next-line react/only-export-components
// oxlint-disable-next-line react/only-export-components
export const useOptionalPortfolio = (): PortfolioContextType | undefined => {
  return useContext(PortfolioContext);
};
