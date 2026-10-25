import { useState, useEffect, useId, type FC } from 'react';
import {
  Layers,
  Calculator,
  ArrowRight,
  CheckCircle2,
  Lock,
  Loader2,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import type { PortfolioPosition, MarketSnapshotRead, PyramidEntryOptions } from '../../types/trading';
import { SAMPLE_NSE_STOCKS } from '../../data/mockStocks';
import { Modal } from '../../components/common/Modal';
import { Button } from '../../components/common/Button';
import { Badge } from '../../components/common/Badge';
import { usePortfolio } from '../../context/PortfolioContext';
import {
  calculateTradeSizing,
  evaluatePyramidingEligibility,
  formatINR,
  formatShares,
} from '../../services/calculations';
import { fetchMarketSnapshot } from '../../services/api';

interface PyramidModalProps {
  position: PortfolioPosition | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmPyramid: (
    positionId: string,
    capital: number,
    notesOrOptions?: string | PyramidEntryOptions,
    options?: PyramidEntryOptions
  ) => Promise<{ success: boolean; error?: string }> | void;
}

export const PyramidModal: FC<PyramidModalProps> = ({
  position,
  isOpen,
  onClose,
  onConfirmPyramid,
}) => {
  const [capital, setCapital] = useState<number>(500000);
  const [notes, setNotes] = useState<string>('');
  const [customExecutionPrice, setCustomExecutionPrice] = useState<string>('');
  const [confirmReferencePrice, setConfirmReferencePrice] = useState<boolean>(false);
  const [acknowledgedInvalidRps, setAcknowledgedInvalidRps] = useState<boolean>(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Authenticated market snapshot state
  const [snapshot, setSnapshot] = useState<MarketSnapshotRead | null>(null);
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState<boolean>(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  const capitalInputId = useId();
  const notesInputId = useId();
  const executionPriceInputId = useId();

  const portfolio = usePortfolio();
  const isDemo = portfolio.isDemoMode;

  // Fetch verified market snapshot in Authenticated Mode
  useEffect(() => {
    if (!isOpen || !position || isDemo) {
      setSnapshot(null);
      setSnapshotError(null);
      setIsLoadingSnapshot(false);
      return;
    }

    let cancelled = false;
    setIsLoadingSnapshot(true);
    setSnapshotError(null);

    fetchMarketSnapshot(position.symbol)
      .then((data) => {
        if (!cancelled) {
          setSnapshot(data);
          setIsLoadingSnapshot(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSnapshot(null);
          setSnapshotError(
            err instanceof Error ? err.message : 'Failed to fetch verified market data for pyramiding.'
          );
          setIsLoadingSnapshot(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, position, isDemo]);

  // Reset inputs when modal opens
  useEffect(() => {
    if (isOpen) {
      setCustomExecutionPrice('');
      setConfirmReferencePrice(false);
      setAcknowledgedInvalidRps(false);
      setErrorMessage(null);
    }
  }, [isOpen, position?.id]);

  if (!position || !position.entries || position.entries.length === 0) return null;

  // The previous entry price is the entry price in the most recent entry row
  const lastEntry = position.entries[position.entries.length - 1];
  const stockSnapshot = isDemo ? SAMPLE_NSE_STOCKS.find((s) => s.symbol === position.symbol) : undefined;

  const refPrice = isDemo
    ? (stockSnapshot ? stockSnapshot.referencePrice : position.currentReferencePrice)
    : (snapshot ? snapshot.lastPrice : position.currentReferencePrice);

  const currentSma = isDemo
    ? (stockSnapshot ? stockSnapshot.twentyWeekSma : position.twentyWeekSmaStopLoss)
    : (snapshot ? snapshot.twentyWeekSma : position.twentyWeekSmaStopLoss);

  const weeklyRsi = isDemo
    ? (stockSnapshot ? stockSnapshot.weeklyRsi : position.latestWeeklyRsi)
    : (snapshot ? snapshot.weeklyRsi : position.latestWeeklyRsi);

  const isStale = !isDemo && Boolean(snapshot?.isStale);

  const hasTechnicalData =
    refPrice !== null &&
    currentSma !== null &&
    weeklyRsi !== null &&
    refPrice !== undefined &&
    currentSma !== undefined &&
    weeklyRsi !== undefined &&
    refPrice > 0 &&
    currentSma > 0 &&
    !isStale;

  // Strict Pyramiding Eligibility Check:
  // 1. Weekly RSI > 60.0 (strictly greater)
  // 2. Previous Entry Price <= 20-week SMA <= Previous Entry Price + 3
  const pCheck = hasTechnicalData
    ? evaluatePyramidingEligibility(weeklyRsi, currentSma, lastEntry.entryPrice)
    : {
        weeklyRsi: weeklyRsi || 0,
        twentyWeekSma: currentSma || 0,
        previousEntryPrice: lastEntry.entryPrice,
        rsiConditionMet: false,
        smaConditionMet: false,
        isEligible: false,
        reasons: isStale
          ? ['Market data quote is stale. Fresh market data is required for pyramiding.']
          : ['Live technical market data (reference price, 20-week SMA, or weekly RSI) is unavailable for this position.'],
      };

  // Parse custom execution price
  const parsedCustomPrice = customExecutionPrice.trim() !== '' ? parseFloat(customExecutionPrice) : null;
  const isCustomPriceValid = parsedCustomPrice !== null && !isNaN(parsedCustomPrice) && parsedCustomPrice > 0;
  const isCustomPriceInvalid = customExecutionPrice.trim() !== '' && !isCustomPriceValid;

  // Effective entry price for sizing: custom price if valid, else EOD reference price
  const effectiveEntryPrice = isCustomPriceValid ? parsedCustomPrice : (refPrice ?? 0);

  // Sizing formula for the new pyramid entry row
  const sizing = hasTechnicalData
    ? calculateTradeSizing({
        userCapital: capital,
        referencePrice: effectiveEntryPrice,
        twentyWeekSma: currentSma,
      })
    : {
        entryPrice: 0,
        stopLoss: 0,
        rps: 0,
        rpt: 0,
        quantity: null,
        sizingStatus: 'UNAVAILABLE' as const,
        capitalRequired: 0,
        warningMessage: 'Market data is unavailable for sizing.',
      };

  const isInvalidRps = sizing.sizingStatus === 'INVALID_RPS_WARNING';
  const hasValidQuantity = sizing.quantity !== null && sizing.quantity > 0;

  const handleConfirm = async () => {
    if (isSubmitting || !pCheck.isEligible || !hasTechnicalData) return;

    if (isCustomPriceInvalid) {
      setErrorMessage('Execution price must be a valid positive number.');
      return;
    }

    if (isInvalidRps && !acknowledgedInvalidRps) {
      setErrorMessage('Stop-loss is at or above entry price. Non-positive risk per share must be explicitly acknowledged.');
      return;
    }

    if (!isInvalidRps && !hasValidQuantity) {
      setErrorMessage('Calculated quantity is 0 shares. Insufficient capital to add pyramid entry with 1% risk budget.');
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const options: PyramidEntryOptions = {
        notes: notes.trim() || undefined,
        executionPrice: isCustomPriceValid ? parsedCustomPrice : undefined,
        confirmReferencePriceAsExecution: parsedCustomPrice === null ? confirmReferencePrice : false,
        acknowledgeInvalidRps: isInvalidRps && acknowledgedInvalidRps,
      };
      const res = await onConfirmPyramid(position.id, capital, options, options);
      if (res && !res.success) {
        setErrorMessage(res.error || 'Failed to record pyramid entry.');
        setIsSubmitting(false);
        return;
      }
      setIsConfirmed(true);
      setTimeout(() => {
        setIsConfirmed(false);
        setIsSubmitting(false);
        onClose();
      }, 1000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to record pyramid entry.';
      setErrorMessage(msg);
      setIsSubmitting(false);
    }
  };

  const nextSequence = position.entries.length + 1;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Pyramid Entry #${nextSequence}: ${position.symbol}`}
      subtitle={`${position.companyName} • Active Position #${position.id}`}
      maxWidth="xl"
    >
      <div className="space-y-5">
        {/* API / Validation Error Alert */}
        {errorMessage && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-300 text-xs flex items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="text-rose-400 hover:text-rose-200 font-bold ml-2"
            >
              ✕
            </button>
          </div>
        )}

        {/* Snapshot Fetch Error Alert */}
        {!isDemo && snapshotError && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800 text-xs text-rose-300 flex items-start gap-2.5"
          >
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <strong className="text-rose-200 block">Market Data Unavailable</strong>
              <p className="text-rose-300/90 leading-relaxed text-[11px]">{snapshotError}</p>
              <button
                type="button"
                onClick={() => {
                  if (position) {
                    setIsLoadingSnapshot(true);
                    setSnapshotError(null);
                    fetchMarketSnapshot(position.symbol)
                      .then((d) => {
                        setSnapshot(d);
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
        {!isDemo && isStale && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-amber-950/60 border border-amber-800 text-xs text-amber-300 flex items-start gap-2.5"
          >
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <strong className="text-amber-200 block">Stale Market Data Quote</strong>
              <p className="text-amber-300/90 leading-relaxed text-[11px]">
                The reference market quote is older than permitted thresholds. Authenticated pyramiding requires fresh market data.
              </p>
            </div>
          </div>
        )}

        {/* Loading Snapshot State */}
        {!isDemo && isLoadingSnapshot && (
          <div className="p-6 rounded-xl bg-slate-950/80 border border-slate-800 text-center space-y-2">
            <Loader2 className="w-6 h-6 animate-spin text-cyan-400 mx-auto" />
            <p className="text-xs text-slate-300 font-medium">Fetching verified market snapshot from provider...</p>
            <p className="text-[11px] text-slate-400">Verifying reference quote and completed weekly candle indicators.</p>
          </div>
        )}

        {/* Missing Technical Data Warning */}
        {!isLoadingSnapshot && !hasTechnicalData && !isStale && (
          <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/60 text-xs text-amber-300 space-y-1">
            <div className="flex items-center gap-2 font-semibold">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>Technical Market Data Unavailable</span>
            </div>
            <p className="text-[11px] text-amber-400/90 pl-6">
              Live reference price, 20-week SMA stop-loss, or weekly RSI quotes are currently unavailable for this position.
              Pyramid sizing and entry creation are disabled to prevent unsafe calculations.
            </p>
          </div>
        )}

        {/* Pyramiding Conditions Evaluation Card */}
        {(!isLoadingSnapshot || isDemo) && (
          <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5 uppercase tracking-wider">
                <Layers className="w-4 h-4 text-cyan-400" />
                <span>Pyramiding Eligibility Evaluation</span>
              </span>
              {pCheck.isEligible ? (
                <Badge variant="success" size="sm" dot>
                  Eligible for Pyramid
                </Badge>
              ) : (
                <Badge variant="danger" size="sm">
                  Not Eligible
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
              {/* Condition 1: RSI > 60 */}
              <div className={`p-3 rounded-lg border ${pCheck.rsiConditionMet ? 'bg-emerald-950/30 border-emerald-800/60' : 'bg-rose-950/30 border-rose-800/60'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 text-[11px]">1. Weekly RSI &gt; 60 (Strict)</span>
                  <span className={`font-mono font-bold ${pCheck.rsiConditionMet ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {hasTechnicalData && weeklyRsi !== undefined && weeklyRsi !== null ? weeklyRsi.toFixed(1) : 'N/A'}
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 mt-1">
                  {pCheck.rsiConditionMet ? '✓ Momentum filter confirmed' : '✗ Must be strictly > 60.0'}
                </p>
              </div>

              {/* Condition 2: Prev Entry <= SMA <= Prev Entry + 3 */}
              <div className={`p-3 rounded-lg border ${pCheck.smaConditionMet ? 'bg-emerald-950/30 border-emerald-800/60' : 'bg-rose-950/30 border-rose-800/60'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 text-[11px]">2. 20W SMA in [Prev, Prev + ₹3]</span>
                  <span className={`font-mono font-bold ${pCheck.smaConditionMet ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {hasTechnicalData && currentSma !== undefined && currentSma !== null ? `₹${currentSma.toFixed(2)}` : 'N/A'}
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 mt-1">
                  Band: [₹{lastEntry.entryPrice.toFixed(2)}, ₹{(lastEntry.entryPrice + 3).toFixed(2)}]
                </p>
              </div>
            </div>

            {!isDemo && snapshot && (
              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                <span>Quote Time: {snapshot.quoteTimestamp}</span>
                <span className="flex items-center gap-1.5">
                  <span>Source:</span>
                  <Badge variant="terminal" size="sm">
                    {snapshot.source}
                  </Badge>
                </span>
              </div>
            )}

            {/* Explanation Banner */}
            <div className="text-[11px] text-slate-400 bg-slate-900 p-2.5 rounded-lg border border-slate-800 space-y-1">
              <div className="font-semibold text-slate-300">Rule Criteria from Architecture:</div>
              {pCheck.reasons.map((r, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className={pCheck.isEligible ? 'text-emerald-400' : 'text-amber-400'}>•</span>
                  <span>{r}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Capital & Notes Input for this Pyramid Step */}
        {hasTechnicalData && pCheck.isEligible && (
          <>
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
                    className="w-full pl-8 pr-4 py-2 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 font-mono text-sm focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none disabled:opacity-50"
                    placeholder={`Leave blank to confirm EOD reference price (${refPrice ? `₹${refPrice.toFixed(2)}` : '...' })`}
                  />
                </div>
                {isCustomPriceInvalid && (
                  <p className="text-[11px] text-rose-400">
                    Execution price must be a valid positive number greater than ₹0.00.
                  </p>
                )}
                <p className="text-[11px] text-slate-400">
                  Enter your actual executed fill price for this pyramid from your broker. If left blank, you must explicitly confirm using the EOD reference closing price.
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
                    <strong className="text-cyan-300 font-mono">{formatINR(refPrice ?? 0)}</strong> as my recorded executed purchase price for this pyramid.
                  </span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor={capitalInputId} className="block text-xs font-semibold text-slate-300">
                Capital for Pyramid #{nextSequence} (₹)
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 font-mono text-sm">
                  ₹
                </span>
                <input
                  id={capitalInputId}
                  type="number"
                  value={capital}
                  onChange={(e) => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
                  step={50000}
                  disabled={isSubmitting}
                  className="w-full pl-8 pr-4 py-2 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 font-mono text-sm focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none disabled:opacity-50"
                />
              </div>
              <p className="text-[11px] text-slate-400 flex items-center justify-between">
                <span>Independent 1% Risk Allocation applies</span>
                <span className="text-cyan-400 font-mono font-semibold">
                  RPT = {formatINR(sizing.rpt)}
                </span>
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor={notesInputId} className="block text-xs font-semibold text-slate-300">
                Optional Notes
              </label>
              <input
                id={notesInputId}
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Reason or plan for this pyramid entry..."
                disabled={isSubmitting}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 text-xs focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none disabled:opacity-50"
              />
            </div>

            {/* Sizing Breakdown */}
            <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
                  <Calculator className="w-4 h-4 text-cyan-400" />
                  <span>{!isDemo ? 'Pyramid Sizing Preview' : 'Pyramid Entry Sizing'}</span>
                </div>
                {!isDemo && (
                  <Badge variant="neutral" size="sm">
                    Server Authoritative
                  </Badge>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs font-mono">
                <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                  <span className="text-slate-400 text-[11px] block font-sans">Effective Entry Price</span>
                  <span className="font-bold text-slate-100">{formatINR(effectiveEntryPrice)}</span>
                </div>

                <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                  <span className="text-slate-400 text-[11px] block font-sans">Stop-Loss (20W SMA)</span>
                  <span className="font-bold text-slate-200">{formatINR(currentSma ?? 0)}</span>
                </div>

                <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 col-span-2 sm:col-span-1">
                  <span className="text-slate-400 text-[11px] block font-sans">Additional Shares</span>
                  <span
                    className={`font-extrabold text-sm ${
                      sizing.quantity !== null && sizing.quantity > 0 ? 'text-cyan-400' : 'text-rose-400'
                    }`}
                  >
                    {sizing.quantity !== null && sizing.quantity > 0
                      ? `+${formatShares(sizing.quantity)} shares`
                      : '0 shares'}
                  </span>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-300">
                <span className="text-slate-400">Projected Accumulated Shares:</span>
                <span className="font-mono font-bold text-slate-100">
                  {formatShares(position.accumulatedQuantity + (sizing.quantity || 0))} shares
                </span>
              </div>

              {!isDemo && (
                <p className="text-[10px] text-slate-400 pt-1 border-t border-slate-800/60 leading-relaxed">
                  * Note: Sizing above is a client preview based on the retrieved snapshot. The backend re-fetches market data and derives official saved entry prices, stop-losses, and quantities upon write.
                </p>
              )}
            </div>

            {/* Warning Case: Insufficient Capital */}
            {sizing.sizingStatus === 'UNAVAILABLE' && sizing.warningMessage && (
              <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-800 text-xs text-amber-200 space-y-1.5">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <strong className="font-bold text-amber-300">
                      Insufficient Capital Allocation
                    </strong>
                    <p className="mt-1 text-[11px] leading-relaxed text-amber-300/90">
                      {sizing.warningMessage}
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
                      Critical Warning: Stop-Loss &gt;= Entry Price
                    </strong>
                    <p className="mt-1 text-[11px] leading-relaxed text-rose-300/90">
                      When Stop-Loss is at or above the entry price, Risk Per Share (RPS) is non-positive. A valid position size cannot be computed. Quantity is preserved as <code>null</code>.
                    </p>
                  </div>
                </div>

                <label className="flex items-center gap-2 pt-2 border-t border-rose-900/60 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acknowledgedInvalidRps}
                    onChange={(e) => setAcknowledgedInvalidRps(e.target.checked)}
                    className="rounded bg-slate-900 border-rose-700 text-rose-600 focus:ring-rose-500"
                  />
                  <span className="text-[11px] text-rose-200">
                    I acknowledge that this position size is invalid and cannot be traded safely.
                  </span>
                </label>
              </div>
            )}
          </>
        )}

        {/* Disclaimer Notice */}
        <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800 flex items-start gap-2.5 text-[11px] text-slate-400">
          <Lock className="w-4 h-4 text-cyan-400/80 shrink-0 mt-0.5" />
          <p>
            <strong>Immutability Rule:</strong> Adding this pyramid creates a distinct new entry row. Prior entry records, entry prices, and recorded stop-losses are permanently preserved and will not be overwritten.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
          <Button variant="outline" size="md" onClick={onClose} disabled={isSubmitting}>
            Close
          </Button>

          {hasTechnicalData && pCheck.isEligible ? (
            <Button
              variant="primary"
              size="md"
              onClick={handleConfirm}
              icon={
                isSubmitting ? (
                  <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
                ) : isConfirmed ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <ArrowRight className="w-4 h-4" />
                )
              }
              iconPosition="right"
              disabled={
                isConfirmed ||
                isSubmitting ||
                isCustomPriceInvalid ||
                (!hasValidQuantity && !isInvalidRps) ||
                (isInvalidRps && !acknowledgedInvalidRps)
              }
            >
              {isSubmitting
                ? 'Recording Pyramid...'
                : isConfirmed
                ? 'Pyramid Confirmed!'
                : `Confirm Pyramid #${nextSequence}`}
            </Button>
          ) : (
            <Button variant="secondary" size="md" disabled>
              {isStale
                ? 'Stale Market Data'
                : !hasTechnicalData
                ? 'Market Data Unavailable'
                : 'Pyramid Ineligible'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
