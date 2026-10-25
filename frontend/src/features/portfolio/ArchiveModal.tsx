import { useState, useId, type FC } from 'react';
import {
  Archive,
  AlertTriangle,
  CheckCircle2,
  Lock,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import type { PortfolioPosition } from '../../types/trading';
import { Modal } from '../../components/common/Modal';
import { Button } from '../../components/common/Button';
import { Badge } from '../../components/common/Badge';
import { formatINR, formatShares } from '../../services/calculations';

interface ArchiveModalProps {
  position: PortfolioPosition | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmArchive: (
    positionId: string,
    reason?: string
  ) =>
    | Promise<{ success: boolean; positionId?: string; error?: string }>
    | { success: boolean; error?: string }
    | void;
}

export const ArchiveModal: FC<ArchiveModalProps> = ({
  position,
  isOpen,
  onClose,
  onConfirmArchive,
}) => {
  const [reason, setReason] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isConfirmed, setIsConfirmed] = useState<boolean>(false);

  const reasonInputId = useId();

  if (!position) return null;

  const handleConfirm = async () => {
    if (isSubmitting || isConfirmed) return;

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const trimmedReason = reason.trim() ? reason.trim() : undefined;
      const res = await onConfirmArchive(position.id, trimmedReason);
      if (res && !res.success) {
        setErrorMessage(res.error || 'Failed to archive position.');
        setIsSubmitting(false);
        return;
      }
      setIsConfirmed(true);
      setTimeout(() => {
        setIsConfirmed(false);
        setIsSubmitting(false);
        setReason('');
        onClose();
      }, 1000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred while archiving.';
      setErrorMessage(msg);
      setIsSubmitting(false);
    }
  };

  const hasExit = !!position.exit;

  return (
    <Modal
      isOpen={isOpen}
      onClose={isSubmitting ? () => {} : onClose}
      title={`Archive Position: ${position.symbol}`}
      subtitle={`${position.companyName} • Status: ${position.status}`}
      maxWidth="md"
    >
      <div className="space-y-4">
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

        {/* Position Summary Card */}
        <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Archive className="w-4 h-4 text-amber-400" />
              <span>Position Summary</span>
            </span>
            <div className="flex items-center gap-1.5">
              <Badge variant={hasExit ? 'success' : 'info'} size="sm">
                {hasExit ? 'Exited' : 'Active'}
              </Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs font-mono pt-1">
            <div>
              <span className="text-[10px] text-slate-400 font-sans block">Total Entries</span>
              <span className="font-bold text-slate-200">{position.entries.length} entries</span>
            </div>
            <div>
              <span className="text-[10px] text-slate-400 font-sans block">Accumulated Shares</span>
              <span className="font-bold text-slate-200">{formatShares(position.accumulatedQuantity)} shares</span>
            </div>
            <div>
              <span className="text-[10px] text-slate-400 font-sans block">Capital Deployed</span>
              <span className="font-bold text-slate-200">{formatINR(position.totalCapitalDeployed)}</span>
            </div>
            <div>
              <span className="text-[10px] text-slate-400 font-sans block">
                {hasExit ? 'Realized P&L' : 'Status'}
              </span>
              {hasExit && position.realizedPnl !== null && position.realizedPnl !== undefined ? (
                <span className={`font-bold ${position.realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {position.realizedPnl >= 0 ? '+' : ''}{formatINR(position.realizedPnl)}
                </span>
              ) : (
                <span className="font-bold text-slate-300">{position.status}</span>
              )}
            </div>
          </div>
        </div>

        {/* Audit Trail Guarantee Notice */}
        <div className="p-3.5 rounded-xl bg-amber-950/30 border border-amber-800/60 text-xs text-amber-200/90 space-y-1">
          <div className="flex items-center gap-1.5 font-semibold text-amber-300">
            <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0" />
            <span>Permanent Audit History Preserved</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
            Archiving soft-archives this position and moves it to the <strong>Archived Positions</strong> view.
            All individual entries, recorded stop-loss snapshots, and P&amp;L records will be permanently retained.
          </p>
        </div>

        {/* Optional Archive Reason Input */}
        <div className="space-y-1.5">
          <label htmlFor={reasonInputId} className="block text-xs font-semibold text-slate-300">
            Archive Reason / Notes (Optional)
          </label>
          <input
            id={reasonInputId}
            type="text"
            disabled={isSubmitting || isConfirmed}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setErrorMessage(null);
            }}
            placeholder="e.g. Target reached / Archived completed position"
            className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs text-slate-200 placeholder:text-slate-500 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none disabled:opacity-50"
          />
        </div>

        {/* Single Archive Notice */}
        <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex items-start gap-2 text-[11px] text-slate-400">
          <Lock className="w-3.5 h-3.5 text-cyan-400/80 shrink-0 mt-0.5" />
          <p>
            Archiving is recorded with a timestamp and moves the position out of your active portfolio.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
          <Button
            variant="outline"
            size="md"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>

          <Button
            variant="danger"
            size="md"
            onClick={handleConfirm}
            disabled={isSubmitting || isConfirmed}
            icon={
              isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin text-white" />
              ) : isConfirmed ? (
                <CheckCircle2 className="w-4 h-4 text-white" />
              ) : (
                <Archive className="w-4 h-4" />
              )
            }
            iconPosition="right"
          >
            {isSubmitting
              ? 'Archiving...'
              : isConfirmed
                ? 'Position Archived!'
                : 'Confirm Archive'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
