import { useState, useEffect, useId, type FC } from 'react';
import {
  Calculator,
  ArrowRight,
  Info,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { ScreenerStock, MarketSnapshotRead, InitialEntryOptions } from '../../types/trading';
import { Modal } from '../../components/common/Modal';
import { Button } from '../../components/common/Button';
import { Badge } from '../../components/common/Badge';
import { useOptionalPortfolio } from '../../context/PortfolioContext';
import {
  calculateTradeSizing,
  formatINR,
  formatShares,
} from '../../services/calculations';
import { fetchMarketSnapshot } from '../../services/api';

export interface TradeEntryModalProps {
  stock?: ScreenerStock | null;
  snapshot?: MarketSnapshotRead | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmEntry?: (
    stockOrSnapshot: ScreenerStock | MarketSnapshotRead,
    capital: number,
    customStopLossOrNotes?: number | string | InitialEntryOptions,
    options?: InitialEntryOptions
  ) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string } | void;
}

export const TradeEntryModal: FC<TradeEntryModalProps> = ({
  stock,
  snapshot: initialSnapshot,
  isOpen,
  onClose,
  onConfirmEntry,
}) => {
  const portfolio = useOptionalPortfolio();
  const isDemoMode = portfolio ? portfolio.isDemoMode : true;

  const [userCapital, setUserCapital] = useState<number>(500000);
  const [customExecutionPrice, setCustomExecutionPrice] = useState<string>('');
  const [confirmReferencePrice, setConfirmReferencePrice] = useState<boolean>(false);
  const [useSimulatedWarning, setUseSimulatedWarning] = useState<boolean>(false);
  const [acknowledgedWarning, setAcknowledgedWarning] = useState<boolean>(false);
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Authenticated market snapshot state
  const [fetchedSnapshot, setFetchedSnapshot] = useState<MarketSnapshotRead | null>(initialSnapshot ?? null);
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState<boolean>(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  const capitalInputId = useId();
  const executionPriceInputId = useId();

  const symbol = initialSnapshot?.symbol || stock?.symbol;
  const displayName = stock?.displayName || initialSnapshot?.symbol || 'NSE Instrument';

  const isSampleFixtureInAuth = !isDemoMode && stock?.dataSource === 'Sample NSE Fixture (Demo)' && !initialSnapshot;

  // Fetch verified market snapshot in Authenticated Mode if not already supplied and not a sample fixture
  useEffect(() => {
    if (!isOpen) return;
    if (isDemoMode || isSampleFixtureInAuth) {
      setFetchedSnapshot(null);
      setSnapshotError(null);
      setIsLoadingSnapshot(false);
      return;
    }

    if (initialSnapshot) {
      setFetchedSnapshot(initialSnapshot);
      setSnapshotError(null);
      setIsLoadingSnapshot(false);
      return;
    }

    if (!symbol) return;

    let cancelled = false;
    setIsLoadingSnapshot(true);
    setSnapshotError(null);

    fetchMarketSnapshot(symbol)
      .then((data) => {
        if (!cancelled) {
          setFetchedSnapshot(data);
          setIsLoadingSnapshot(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFetchedSnapshot(null);
          setSnapshotError(
            err instanceof Error ? err.message : 'Failed to fetch verified market data.'
          );
          setIsLoadingSnapshot(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, isDemoMode, isSampleFixtureInAuth, initialSnapshot, symbol]);

  // Reset inputs when opening modal
  useEffect(() => {
    if (isOpen) {
      setCustomExecutionPrice('');
      setConfirmReferencePrice(false);
      setAcknowledgedWarning(false);
      setUseSimulatedWarning(false);
      setErrorMessage(null);
    }
  }, [isOpen, symbol]);

  if (!isOpen || (!stock && !initialSnapshot && !symbol)) return null;

  // Reference parameters: Demo Mode uses ScreenerStock; Authenticated Mode uses MarketSnapshotRead
  const activeSnapshot = !isDemoMode ? (fetchedSnapshot || initialSnapshot || null) : null;
  const referencePrice = isDemoMode
    ? (stock?.referencePrice ?? 0)
    : (activeSnapshot?.lastPrice ?? 0);

  const referenceTwentyWeekSma = isDemoMode
    ? (stock?.twentyWeekSma ?? 0)
    : (activeSnapshot?.twentyWeekSma ?? null);

  const activeWeeklyRsi = isDemoMode
    ? (stock?.weeklyRsi ?? 0)
    : (activeSnapshot?.weeklyRsi ?? null);

  const isStale = isDemoMode ? false : Boolean(activeSnapshot?.isStale);

  // Parse custom execution price
  const parsedCustomPrice = customExecutionPrice.trim() !== '' ? parseFloat(customExecutionPrice) : null;
  const isCustomPriceValid = parsedCustomPrice !== null && !isNaN(parsedCustomPrice) && parsedCustomPrice > 0;
  const isCustomPriceInvalid = customExecutionPrice.trim() !== '' && !isCustomPriceValid;

  // Effective entry price: custom execution price if valid, else EOD reference price
  const effectiveEntryPrice = isCustomPriceValid ? parsedCustomPrice : referencePrice;

  // Stop loss determination
  const activeStopLoss = useSimulatedWarning
    ? effectiveEntryPrice + 15.00
    : (referenceTwentyWeekSma ?? effectiveEntryPrice);

  // Sizing result calculation using effective entry price
  const sizingResult = referenceTwentyWeekSma !== null
    ? calculateTradeSizing({
        userCapital,
        referencePrice: effectiveEntryPrice,
        twentyWeekSma: activeStopLoss,
      })
    : {
        rpt: userCapital * 0.01,
        entryPrice: effectiveEntryPrice,
        stopLoss: 0,
        rps: 0,
        quantity: null,
        sizingStatus: 'UNAVAILABLE' as const,
        capitalRequired: null,
      };

  const isInvalidRps = sizingResult.sizingStatus === 'INVALID_RPS_WARNING';
  const hasValidQuantity = sizingResult.quantity !== null && sizingResult.quantity > 0;

  // Qualification in Authenticated Mode
  const isRsiPassing = activeWeeklyRsi !== null && activeWeeklyRsi > 60.0;
  const isSmaAvailable = referenceTwentyWeekSma !== null;
  const isAuthenticatedReady = !isDemoMode && activeSnapshot && !isLoadingSnapshot && !snapshotError;

  const handleSave = async () => {
    if (isSubmitting) return;

    if (!isDemoMode) {
      if (snapshotError) {
        setErrorMessage(snapshotError);
        return;
      }
      if (!activeSnapshot) {
        setErrorMessage('Verified market snapshot has not loaded.');
        return;
      }
      if (isStale) {
        setErrorMessage('Market data is stale. Fresh market data is required for trading.');
        return;
      }
      if (!isRsiPassing) {
        setErrorMessage('Weekly RSI does not qualify (must be strictly > 60.0).');
        return;
      }
      if (!isSmaAvailable) {
        setErrorMessage('20-week completed SMA stop-loss is unavailable.');
        return;
      }
    }

    if (isCustomPriceInvalid) {
      setErrorMessage('Execution price must be a valid positive number.');
      return;
    }

    if (isInvalidRps && !acknowledgedWarning) return;
    if (!isInvalidRps && !hasValidQuantity) {
      setErrorMessage('Calculated quantity is 0 shares. Insufficient capital to open position with 1% risk budget.');
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      if (onConfirmEntry) {
        const payloadTarget = !isDemoMode && activeSnapshot ? activeSnapshot : (stock as ScreenerStock);
        const options: InitialEntryOptions = {
          notes: useSimulatedWarning ? 'Simulated Stop-Loss >= Entry' : undefined,
          executionPrice: isCustomPriceValid ? parsedCustomPrice : undefined,
          confirmReferencePriceAsExecution: parsedCustomPrice === null ? confirmReferencePrice : false,
          acknowledgeInvalidRps: isInvalidRps && acknowledgedWarning,
        };
        const res = await onConfirmEntry(
          payloadTarget,
          userCapital,
          useSimulatedWarning ? activeStopLoss : options,
          options
        );
        if (res && !res.success) {
          setErrorMessage(res.error || 'Failed to record entry.');
          setIsSubmitting(false);
          return;
        }
      }

      setSavedSuccess(true);
      setTimeout(() => {
        setSavedSuccess(false);
        setIsSubmitting(false);
        onClose();
      }, 1000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to record entry.';
      setErrorMessage(msg);
      setIsSubmitting(false);
    }
  };

  const canSubmit = !isSampleFixtureInAuth && (isDemoMode
    ? !isSubmitting && ((isInvalidRps && acknowledgedWarning) || (!isInvalidRps && hasValidQuantity))
    : isAuthenticatedReady &&
      !isSubmitting &&
      !isStale &&
      isRsiPassing &&
      isSmaAvailable &&
      !isCustomPriceInvalid &&
      ((isInvalidRps && acknowledgedWarning) || (!isInvalidRps && hasValidQuantity)));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Trade Parameter & Sizing: ${symbol}`}
      subtitle={`${displayName} • NSE Cash Market`}
      maxWidth="xl"
    >
      <div className="space-y-5">
        {/* Error Alert */}
        {errorMessage && (
          <div role="alert" className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800 text-xs text-rose-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Sample Stock Fixture in Authenticated Mode Safeguard Alert */}
        {isSampleFixtureInAuth && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-amber-950/60 border border-amber-800 text-xs text-amber-300 flex items-start gap-2.5"
          >
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <strong className="text-amber-200 block">Verified NSE Market Data Required</strong>
              <p className="text-amber-300/90 leading-relaxed text-[11px]">
                Authenticated entry creation is temporarily unavailable because verified NSE market data has not been connected. Mock stock fixtures cannot be submitted as genuine trading entries. Switch to Demo Mode to test paper-trading entries with sample data.
              </p>
            </div>
          </div>
        )}

        {/* Snapshot Fetch Error Alert */}
        {!isDemoMode && snapshotError && (
          <div role="alert" className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800 text-xs text-rose-300 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <strong className="text-rose-200 block">Market Data Unavailable</strong>
              <p className="text-rose-300/90 leading-relaxed text-[11px]">{snapshotError}</p>
              <button
                type="button"
                onClick={() => {
                  if (symbol) {
                    setIsLoadingSnapshot(true);
                    setSnapshotError(null);
                    fetchMarketSnapshot(symbol)
                      .then((d) => {
                        setFetchedSnapshot(d);
                        setIsLoadingSnapshot(false);
                      })
                      .catch((e) => {
                        setSnapshotError(e instanceof Error ? e.message : 'Retry failed.');
                        setIsLoadingSnapshot(false);
                      });
                  }
                }}
                className="mt-1 inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-rose-900/60 hover:bg-rose-800 text-rose-200 text-[11px] font-semibold border border-rose-700"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Retry Market Data</span>
              </button>
            </div>
          </div>
        )}

        {/* Stale Quote Warning */}
        {!isDemoMode && isStale && (
          <div role="alert" className="p-3.5 rounded-xl bg-amber-950/60 border border-amber-800 text-xs text-amber-300 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <strong className="text-amber-200 block">Stale Market Data Quote</strong>
              <p className="text-amber-300/90 leading-relaxed text-[11px]">
                The reference market quote is older than permitted thresholds. Authenticated trade creation requires fresh market data.
              </p>
            </div>
          </div>
        )}

        {/* Loading Snapshot State */}
        {!isDemoMode && isLoadingSnapshot && (
          <div className="p-6 rounded-xl bg-slate-950/80 border border-slate-800 text-center space-y-2">
            <Loader2 className="w-6 h-6 animate-spin text-cyan-400 mx-auto" />
            <p className="text-xs text-slate-300 font-medium">Fetching verified market snapshot from provider...</p>
            <p className="text-[11px] text-slate-400">Verifying reference quote and completed weekly candle indicators.</p>
          </div>
        )}

        {/* Market Reference Header Card */}
        {(!isLoadingSnapshot || isDemoMode) && (
          <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-xs text-slate-400">
                {activeSnapshot?.source === 'TEJHQ' ? 'EOD Reference Close' : 'Current Reference Price'}
              </div>
              <div className="text-2xl font-bold font-mono text-cyan-400">
                {formatINR(referencePrice)}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                {isDemoMode
                  ? `Ref As-Of: ${stock?.referencePriceAsOf || 'Demo Fixture'}`
                  : `Quote Time: ${activeSnapshot?.quoteTimestamp || 'N/A'}`}
              </div>
            </div>

            <div className="text-right">
              <div className="text-xs text-slate-400">20-Week Completed SMA</div>
              <div className="text-2xl font-bold font-mono text-slate-200">
                {referenceTwentyWeekSma !== null ? formatINR(activeStopLoss) : 'Unavailable'}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                {isDemoMode
                  ? `Candle Date: ${stock?.latestCompletedWeeklyCandleDate || 'Demo'}`
                  : `Candle Date: ${activeSnapshot?.latestCompletedCandleDate || 'N/A'}`}
              </div>
            </div>

            <div className="w-full pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
              <span className="text-slate-400">Weekly RSI (Strict &gt; 60):</span>
              <span
                className={`font-mono font-bold ${
                  activeWeeklyRsi !== null && activeWeeklyRsi > 60.0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {activeWeeklyRsi !== null ? activeWeeklyRsi.toFixed(1) : 'N/A'}{' '}
                {activeWeeklyRsi !== null && activeWeeklyRsi > 60.0 ? '✓ PASS' : '✗ FAIL'}
              </span>
            </div>

            {!isDemoMode && activeSnapshot && (
              <div className="w-full pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                <span className="flex items-center gap-1.5">
                  <span className="text-slate-400">Source:</span>
                  <Badge variant="terminal" size="sm">
                    {activeSnapshot.source === 'TEJHQ' ? 'TejHQ EOD' : activeSnapshot.source}
                  </Badge>
                </span>
                <Badge variant={activeSnapshot.isStale ? 'warning' : 'success'} size="sm" dot>
                  {activeSnapshot.isStale
                    ? 'Stale Quote'
                    : activeSnapshot.source === 'TEJHQ'
                    ? 'Verified EOD Reference'
                    : 'Live Verified Quote'}
                </Badge>
              </div>
            )}
          </div>
        )}

        {/* Execution Price Input & Reference Price Confirmation */}
        <div className="space-y-3 p-4 rounded-xl bg-slate-950/60 border border-slate-800">
          <div className="space-y-1.5">
            <label htmlFor={executionPriceInputId} className="block text-xs font-semibold text-slate-300">
              Actual Executed Purchase Price (₹) — Optional
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 font-mono text-sm">
                ₹
              </span>
              <input
                id={executionPriceInputId}
                type="number"
                step="0.05"
                min="0.01"
                value={customExecutionPrice}
                onChange={(e) => {
                  setCustomExecutionPrice(e.target.value);
                  if (confirmReferencePrice) {
                    setConfirmReferencePrice(false);
                  }
                }}
                disabled={isSubmitting}
                className="w-full pl-8 pr-4 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 font-mono text-sm focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none disabled:opacity-50"
                placeholder={`Leave blank to confirm EOD reference price (${referencePrice ? `₹${referencePrice.toFixed(2)}` : '...' })`}
              />
            </div>
            {isCustomPriceInvalid && (
              <p className="text-[11px] text-rose-400">
                Execution price must be a valid positive number greater than ₹0.00.
              </p>
            )}
            <p className="text-[11px] text-slate-400">
              Enter your actual executed fill price from your broker. If left blank, you must explicitly confirm using the EOD reference closing price.
            </p>
          </div>

          {/* Explicit Confirmation (shown when no custom execution price is entered) */}
          {!customExecutionPrice.trim() && (
            <div
              onClick={() => !isSubmitting && setConfirmReferencePrice(!confirmReferencePrice)}
              className="flex items-start gap-2.5 p-3 rounded-lg bg-slate-900/90 border border-slate-700/80 cursor-pointer transition-colors hover:border-slate-600"
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={confirmReferencePrice}
                disabled={isSubmitting}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmReferencePrice(!confirmReferencePrice);
                }}
                className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center border transition-colors ${
                  confirmReferencePrice
                    ? 'bg-cyan-600 border-cyan-500 text-white'
                    : 'bg-slate-950 border-slate-600'
                }`}
              >
                {confirmReferencePrice && <CheckCircle2 className="w-3.5 h-3.5" />}
              </button>
              <span className="text-xs text-slate-300 leading-relaxed select-none">
                I confirm using the EOD reference closing price of{' '}
                <strong className="text-cyan-300 font-mono">{formatINR(referencePrice)}</strong> as my recorded executed purchase price.
              </span>
            </div>
          )}
        </div>

        {/* Capital Allocation Input */}
        <div className="space-y-1.5">
          <label htmlFor={capitalInputId} className="block text-xs font-semibold text-slate-300">
            User Trading Capital (₹)
          </label>
          <div className="relative">
            <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 font-mono text-sm">
              ₹
            </span>
            <input
              id={capitalInputId}
              type="number"
              value={userCapital}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setUserCapital(isNaN(val) ? 0 : Math.max(0, val));
              }}
              min={10000}
              step={50000}
              disabled={isSubmitting}
              className="w-full pl-8 pr-4 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 font-mono text-sm focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none disabled:opacity-50"
              placeholder="500000"
            />
          </div>
          <p className="text-[11px] text-slate-400 flex items-center justify-between">
            <span>Standard 1% Risk Rule automatically applies</span>
            <span className="text-cyan-400 font-mono font-semibold">
              RPT = {formatINR(sizingResult.rpt)}
            </span>
          </p>
        </div>

        {/* Sizing Breakdown Calculation Table */}
        <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
              <Calculator className="w-4 h-4 text-cyan-400" />
              <span>{!isDemoMode ? 'Deterministic Sizing Preview' : 'Deterministic Sizing Formula'}</span>
            </div>
            {!isDemoMode && (
              <Badge variant="neutral" size="sm">
                Server Authoritative
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
              <span className="text-slate-400 text-[11px] block">Risk Per Trade (1%)</span>
              <span className="font-mono font-bold text-cyan-300 text-sm">
                {formatINR(sizingResult.rpt)}
              </span>
            </div>

            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
              <span className="text-slate-400 text-[11px] block">Risk Per Share (RPS)</span>
              <span
                className={`font-mono font-bold text-sm ${
                  sizingResult.rps > 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {sizingResult.rps > 0 ? `+₹${sizingResult.rps.toFixed(2)}` : `₹${sizingResult.rps.toFixed(2)}`}
              </span>
            </div>

            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 col-span-2 sm:col-span-1">
              <span className="text-slate-400 text-[11px] block">Calculated Quantity</span>
              <span
                className={`font-mono font-extrabold text-base ${
                  sizingResult.quantity !== null && sizingResult.quantity > 0 ? 'text-cyan-400' : 'text-rose-400'
                }`}
              >
                {sizingResult.quantity !== null && sizingResult.quantity > 0
                  ? `${formatShares(sizingResult.quantity)} shares`
                  : 'Unavailable'}
              </span>
            </div>
          </div>

          {sizingResult.capitalRequired && (
            <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 text-xs">
              <span className="text-slate-400">Total Capital Required for Entry:</span>
              <span className="font-mono font-semibold text-slate-200">
                {formatINR(sizingResult.capitalRequired)}
              </span>
            </div>
          )}

          {!isDemoMode && (
            <p className="text-[10px] text-slate-400 pt-1 border-t border-slate-800/60 leading-relaxed">
              * Note: The calculated quantity above is a client preview. The backend server independently re-fetches market data and authoritatively derives and saves official entry prices, stop-losses, and quantities.
            </p>
          )}
        </div>

        {/* Warning Case: Insufficient Capital */}
        {sizingResult.sizingStatus === 'UNAVAILABLE' && sizingResult.warningMessage && (
          <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-800 text-xs text-amber-200 space-y-1.5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <strong className="font-bold text-amber-300">
                  Insufficient Capital Allocation
                </strong>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-300/90">
                  {sizingResult.warningMessage}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Warning Case: Stop-Loss >= Entry Price */}
        {isInvalidRps && (
          <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-800 text-xs text-rose-200 space-y-2.5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <strong className="font-bold text-rose-300">
                  Critical Warning: Stop-Loss &gt;= Reference Entry Price
                </strong>
                <p className="mt-1 text-[11px] leading-relaxed text-rose-300/90">
                  Under confirmed trading rules, when Stop-Loss is at or above the reference entry price, Risk Per Share (RPS) is zero or negative. A valid position size cannot be computed. Quantity is preserved as <code>null</code>.
                </p>
              </div>
            </div>

            <label className="flex items-center gap-2 pt-2 border-t border-rose-900/60 cursor-pointer">
              <input
                type="checkbox"
                checked={acknowledgedWarning}
                onChange={(e) => setAcknowledgedWarning(e.target.checked)}
                className="rounded bg-slate-900 border-rose-700 text-rose-600 focus:ring-rose-500"
              />
              <span className="text-[11px] text-rose-200">
                I acknowledge that this position size is invalid and cannot be traded safely.
              </span>
            </label>
          </div>
        )}

        {/* Edge Case Testing Toggle: Allows reviewer to test the Stop-Loss >= Entry warning flow */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs">
          <span className="text-slate-400 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5 text-cyan-400" />
            <span>Test Sizing Guardrail:</span>
          </span>
          <button
            type="button"
            onClick={() => {
              setUseSimulatedWarning(!useSimulatedWarning);
              setAcknowledgedWarning(false);
            }}
            className={`px-2.5 py-1 rounded text-[11px] font-mono font-medium transition-colors border ${
              useSimulatedWarning
                ? 'bg-rose-950 text-rose-300 border-rose-800'
                : 'bg-slate-900 text-slate-300 border-slate-700 hover:bg-slate-800'
            }`}
          >
            {useSimulatedWarning ? 'Revert to Real 20W SMA' : 'Simulate Stop-Loss >= Entry'}
          </button>
        </div>

        {/* EOD Reference Notice */}
        {!isDemoMode && activeSnapshot?.source === 'TEJHQ' && (
          <div className="p-3 rounded-lg bg-sky-950/40 border border-sky-800/80 flex items-start gap-2.5 text-[11px] text-sky-200">
            <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
            <p>
              <strong>EOD Reference Price Notice:</strong> The reference price shown ({formatINR(referencePrice)}) is the official closing price from TejHQ end-of-day data for analysis. By recording this entry, you confirm the accepted execution price for portfolio record-keeping.
            </p>
          </div>
        )}

        {/* Disclaimer Notice */}
        <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 flex items-start gap-2.5 text-[11px] text-slate-400">
          <Lock className="w-4 h-4 text-cyan-400/80 shrink-0 mt-0.5" />
          <p>
            <strong>Decision Support Safeguard:</strong> This application calculates sizing parameters for paper tracking. No actual broker orders are placed. Values reflect the most recently completed weekly candle.
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
          <Button variant="outline" size="md" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>

          <Button
            variant={canSubmit ? (isInvalidRps ? 'secondary' : 'primary') : 'secondary'}
            size="md"
            onClick={handleSave}
            disabled={!canSubmit}
            icon={
              savedSuccess ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              ) : isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
              ) : (
                <ArrowRight className="w-4 h-4" />
              )
            }
            iconPosition="right"
          >
            {isSampleFixtureInAuth
              ? 'Creation Disabled (Sample Data)'
              : savedSuccess
              ? 'Recorded to Portfolio!'
              : isSubmitting
              ? 'Recording Entry...'
              : !isDemoMode && isStale
              ? 'Entry Disabled (Stale Data)'
              : !isDemoMode && !isRsiPassing
              ? 'Entry Disabled (RSI ≤ 60)'
              : !isDemoMode && !isSmaAvailable
              ? 'Entry Disabled (SMA Unavailable)'
              : isInvalidRps
              ? 'Save Entry (Null Size)'
              : 'Record Entry'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
