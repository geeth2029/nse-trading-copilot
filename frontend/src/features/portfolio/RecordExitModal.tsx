import { useState, useId, type FC } from 'react';
import {
  LogOut,
  AlertTriangle,
  TrendingUp,
  CheckCircle2,
  Lock,
  Loader2,
} from 'lucide-react';
import type { PortfolioPosition } from '../../types/trading';
import { Modal } from '../../components/common/Modal';
import { Button } from '../../components/common/Button';
import {
  calculatePositionPnl,
  formatINR,
  formatShares,
  validateExitData,
} from '../../services/calculations';

interface RecordExitModalProps {
  position: PortfolioPosition | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmExit: (
    positionId: string,
    exitPrice: number,
    exitDate: string,
    notes?: string
  ) =>
    | Promise<{ success: boolean; positionId?: string; error?: string }>
    | { success: boolean; error?: string }
    | void;
}

export const RecordExitModal: FC<RecordExitModalProps> = ({
  position,
  isOpen,
  onClose,
  onConfirmExit,
}) => {
  const [exitPrice, setExitPrice] = useState<number>(position?.currentReferencePrice || 0);
  const [exitDate, setExitDate] = useState<string>(() => new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isConfirmed, setIsConfirmed] = useState<boolean>(false);

  const priceInputId = useId();
  const dateInputId = useId();
  const notesInputId = useId();

  if (!position) return null;

  // Real-time calculation of Entry-wise and Consolidated P&L
  const { entryPnls, totalPnl, hasUnavailableQuantity } = calculatePositionPnl(
    position.entries,
    exitPrice
  );

  const handleConfirm = async () => {
    if (isSubmitting || isConfirmed) return;

    const validation = validateExitData(exitPrice, exitDate);
    if (!validation.isValid) {
      setValidationError(validation.error || 'Invalid exit data.');
      return;
    }

    if (position.initialEntryDate && exitDate < position.initialEntryDate) {
      setValidationError('Exit date cannot precede initial entry date.');
      return;
    }

    setValidationError(null);
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const res = await onConfirmExit(position.id, exitPrice, exitDate, notes);
      if (res && !res.success) {
        setErrorMessage(res.error || 'Failed to record exit.');
        setIsSubmitting(false);
        return;
      }
      setIsConfirmed(true);
      setTimeout(() => {
        setIsConfirmed(false);
        setIsSubmitting(false);
        onClose();
      }, 1200);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
      setErrorMessage(msg);
      setIsSubmitting(false);
    }
  };

  const isTotalPositive = totalPnl !== null && totalPnl >= 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Record Position Exit: ${position.symbol}`}
      subtitle={`${position.companyName} • Accumulated Quantity: ${formatShares(position.accumulatedQuantity)} shares`}
      maxWidth="xl"
    >
      <div className="space-y-5">
        {/* Validation Error Alert */}
        {validationError && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800 text-xs text-rose-300 flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{validationError}</span>
          </div>
        )}

        {/* API Error Alert */}
        {errorMessage && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800 text-xs text-rose-300 flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Exit Inputs: Price & Date */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor={priceInputId} className="block text-xs font-semibold text-slate-300">
              Recorded Exit Price (₹) *
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-400 font-mono text-xs">
                ₹
              </span>
              <input
                id={priceInputId}
                type="number"
                step="0.05"
                min="0.01"
                disabled={isSubmitting || isConfirmed}
                value={exitPrice || ''}
                onChange={(e) => {
                  setExitPrice(parseFloat(e.target.value) || 0);
                  setValidationError(null);
                  setErrorMessage(null);
                }}
                className="w-full pl-8 pr-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 font-mono text-sm focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none disabled:opacity-50"
                placeholder="0.00"
              />
            </div>
            <span className="text-[10px] text-slate-400">
              Ref Price: {formatINR(position.currentReferencePrice)}
            </span>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={dateInputId} className="block text-xs font-semibold text-slate-300">
              Exit Date *
            </label>
            <input
              id={dateInputId}
              type="date"
              disabled={isSubmitting || isConfirmed}
              value={exitDate}
              onChange={(e) => {
                setExitDate(e.target.value);
                setValidationError(null);
                setErrorMessage(null);
              }}
              className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-slate-100 font-mono text-sm focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none disabled:opacity-50"
            />
            <span className="text-[10px] text-slate-400">
              Initial Entry Date: {position.initialEntryDate}
            </span>
          </div>
        </div>

        {/* Optional Exit Notes */}
        <div className="space-y-1.5">
          <label htmlFor={notesInputId} className="block text-xs font-semibold text-slate-300">
            Exit Reason / Journal Notes (Optional)
          </label>
          <input
            id={notesInputId}
            type="text"
            disabled={isSubmitting || isConfirmed}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Trailing stop-loss breached on 20-week SMA weekly close"
            className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs text-slate-200 placeholder:text-slate-400 focus:border-cyan-400 outline-none disabled:opacity-50"
          />
        </div>

        {/* Live Entry-Wise and Consolidated P&L Preview Table */}
        <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-cyan-400" />
              <span>Entry-Wise P&amp;L Breakdown</span>
            </span>
            <span className="text-[10px] text-slate-400">No transaction costs</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] text-slate-400 uppercase font-sans">
                  <th className="pb-2">Entry</th>
                  <th className="pb-2 text-right">Entry Price</th>
                  <th className="pb-2 text-right">Shares</th>
                  <th className="pb-2 text-right">Exit Price</th>
                  <th className="pb-2 text-right">Entry Gross P&amp;L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {position.entries.map((entry, idx) => {
                  const pnl = entryPnls[idx];
                  const isPositive = pnl !== null && pnl >= 0;
                  return (
                    <tr key={entry.id} className="text-slate-300">
                      <td className="py-2 font-sans font-medium text-slate-200">
                        {entry.sequence === 1 ? 'Initial Entry' : `Pyramid #${entry.sequence - 1}`}
                      </td>
                      <td className="py-2 text-right">{formatINR(entry.entryPrice)}</td>
                      <td className="py-2 text-right">
                        {entry.quantity !== null ? formatShares(entry.quantity) : (
                          <span className="text-rose-400 font-sans text-[11px]">Unavailable</span>
                        )}
                      </td>
                      <td className="py-2 text-right text-slate-400">
                        {exitPrice > 0 ? formatINR(exitPrice) : '₹--'}
                      </td>
                      <td className="py-2 text-right font-bold">
                        {pnl !== null ? (
                          <span className={isPositive ? 'text-emerald-400' : 'text-rose-400'}>
                            {isPositive ? '+' : ''}{formatINR(pnl)}
                          </span>
                        ) : (
                          <span className="text-slate-400 text-[11px]">Unavailable</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Consolidated P&L Footer */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
            <div>
              <span className="text-xs font-bold text-slate-200 font-sans block">
                Consolidated Gross Realized P&amp;L
              </span>
              <span className="text-[10px] text-slate-400 font-sans">
                Sum of individual entry P&amp;Ls ({formatShares(position.accumulatedQuantity)} total shares)
              </span>
            </div>
            <div className="text-right">
              <div
                className={`text-xl font-bold font-mono ${
                  isTotalPositive ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {totalPnl !== null ? `${isTotalPositive ? '+' : ''}${formatINR(totalPnl)}` : 'Unavailable'}
              </div>
            </div>
          </div>

          {hasUnavailableQuantity && (
            <p className="text-[11px] text-amber-300/90 pt-1 font-sans">
              * Note: One or more entries have unavailable sizing; consolidated P&amp;L cannot be computed.
            </p>
          )}
        </div>

        {/* Architecture Rule Safeguard Notice */}
        <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800 flex items-start gap-2 text-[11px] text-slate-400">
          <Lock className="w-4 h-4 text-cyan-400/80 shrink-0 mt-0.5" />
          <p>
            <strong>Single Exit Rule:</strong> In accordance with confirmed business rules, one exit applies to the entire accumulated position. An exit cannot be recorded twice.
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
          <Button variant="outline" size="md" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>

          <Button
            variant="danger"
            size="md"
            onClick={handleConfirm}
            disabled={isSubmitting || isConfirmed || exitPrice <= 0 || !exitDate}
            icon={
              isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin text-white" />
              ) : isConfirmed ? (
                <CheckCircle2 className="w-4 h-4 text-white" />
              ) : (
                <LogOut className="w-4 h-4" />
              )
            }
            iconPosition="right"
          >
            {isSubmitting
              ? 'Recording Exit...'
              : isConfirmed
                ? 'Position Closed!'
                : 'Confirm Position Exit'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
