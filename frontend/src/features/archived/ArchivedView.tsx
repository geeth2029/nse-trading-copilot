import { useState, type FC } from 'react';
import {
  Archive,
  ShieldCheck,
  RotateCcw,
  CheckCircle2,
  Lock,
  Loader2,
  AlertTriangle,
  RefreshCw,
  FileDown,
} from 'lucide-react';
import { usePortfolio } from '../../context/PortfolioContext';
import { useOptionalAuth } from '../../context/AuthContext';
import { Badge } from '../../components/common/Badge';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import {
  formatINR,
  formatShares,
} from '../../services/calculations';
import { generatePositionPdf } from '../../services/pdfReportService';

export const ArchivedView: FC = () => {
  const auth = useOptionalAuth();
  const user = auth?.user;
  const {
    archivedPositions,
    restorePosition,
    isDemoMode,
    isLoadingPortfolio,
    portfolioError,
    refreshPortfolio,
    setPortfolioMode,
  } = usePortfolio();
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const handleRestore = async (id: string, symbol: string) => {
    if (restoringId !== null) return;
    setRestoringId(id);
    try {
      const res = await restorePosition(id);
      if (res.success) {
        setToastMessage(`Position ${symbol} restored to portfolio.`);
        setTimeout(() => setToastMessage(null), 3000);
      } else if (res.error) {
        setToastMessage(res.error);
        setTimeout(() => setToastMessage(null), 4000);
      }
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toastMessage && (
        <div className="p-4 rounded-xl bg-cyan-950 border border-cyan-700 text-cyan-200 text-xs flex items-center justify-between shadow-xl">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-cyan-400" />
            <span>{toastMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            className="text-cyan-400 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Archive className="w-5 h-5 text-amber-400" />
            <span>Archived Positions &amp; Permanent History</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Complete, immutable audit trail of soft-archived positions. Entry rows, recorded stop-loss snapshots, and single-exit records are permanently retained.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={isDemoMode ? 'warning' : 'info'} size="md">
            {isDemoMode ? 'Demo Mode' : 'Live Portfolio'}
          </Badge>
          <Badge variant="neutral" size="md">
            {archivedPositions.length} Historical Positions Preserved
          </Badge>
        </div>
      </div>

      {/* Loading State */}
      {isLoadingPortfolio && (
        <Card className="text-center py-12 flex flex-col items-center justify-center">
          <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mb-3" />
          <h3 className="text-base font-semibold text-slate-200">Loading Archived Positions...</h3>
          <p className="text-xs text-slate-400 mt-1">
            Querying server-side historical portfolio records
          </p>
        </Card>
      )}

      {/* Error State */}
      {!isLoadingPortfolio && portfolioError && (
        <div className="p-4 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xl">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-rose-100">Unable to load portfolio history</p>
              <p className="text-rose-300 text-[11px] mt-0.5">{portfolioError}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={refreshPortfolio}
              icon={<RefreshCw className="w-3.5 h-3.5" />}
            >
              Retry
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPortfolioMode('demo')}
            >
              Switch to Demo
            </Button>
          </div>
        </div>
      )}

      {/* Retention Policy Banner */}
      <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 flex items-start gap-3">
        <div className="p-2 rounded-lg bg-amber-950 text-amber-400 border border-amber-800 shrink-0">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <div>
          <h3 className="font-bold text-slate-100">Permanent Record Retention Policy</h3>
          <p className="text-slate-400 text-[11px] mt-1 leading-relaxed">
            Per <code>docs/architecture.md</code>, archiving or removing a stock from the active portfolio retains its entire trading history. Positions, immutable entry snapshots, recorded stop-losses, and exit calculations are never cascade-deleted.
          </p>
        </div>
      </div>

      {/* Empty State */}
      {!isLoadingPortfolio && !portfolioError && archivedPositions.length === 0 ? (
        <Card className="text-center py-12">
          <Archive className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-200">
            {isDemoMode ? 'No Archived Positions' : 'No Archived Positions in Account'}
          </h3>
          <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
            {isDemoMode
              ? 'Positions soft-archived from the Active Portfolio page will appear here with their complete entry history preserved.'
              : 'Your authenticated account has no soft-archived records. Soft-archiving positions from the active portfolio preserves them here permanently.'}
          </p>
        </Card>
      ) : !isLoadingPortfolio && !portfolioError && (
        /* Each archived position has its own complete history table */
        <div className="space-y-6">
          {archivedPositions.map((pos) => {
            const hasExit = pos.exit !== undefined;
            const isPositivePnl = pos.realizedPnl !== null && pos.realizedPnl !== undefined && pos.realizedPnl >= 0;

            return (
              <div
                key={pos.id}
                className="rounded-xl bg-slate-900 border border-slate-800/80 shadow-xl overflow-hidden"
              >
                {/* Position Header Banner */}
                <div className="p-5 border-b border-slate-800 bg-slate-950/70 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-amber-400 mt-0.5">
                      <Archive className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="text-lg font-bold font-mono text-slate-100">
                          {pos.symbol}
                        </span>
                        <span className="text-xs text-slate-400">
                          {pos.companyName}
                        </span>
                        <Badge variant="neutral" size="sm">
                          Soft-Archived
                        </Badge>
                        {hasExit && (
                          <Badge variant="success" size="sm">
                            Exited at {formatINR(pos.exit?.exitPrice)}
                          </Badge>
                        )}
                      </div>

                      {pos.archiveReason && (
                        <p className="text-xs text-slate-400 mt-1 italic">
                          Archive Reason: {pos.archiveReason}
                        </p>
                      )}

                      <div className="flex items-center gap-4 sm:gap-6 mt-2 text-xs flex-wrap font-mono">
                        <div>
                          <span className="text-slate-400 font-sans text-[11px] block">Accumulated Quantity</span>
                          <span className="font-extrabold text-slate-200">
                            {formatShares(pos.accumulatedQuantity)} shares
                          </span>
                        </div>

                        <div>
                          <span className="text-slate-400 font-sans text-[11px] block">Weighted Avg Entry</span>
                          <span className="font-semibold text-slate-300">
                            {formatINR(pos.averageEntryPrice)}
                          </span>
                        </div>

                        {hasExit && (
                          <div>
                            <span className="text-slate-400 font-sans text-[11px] block">Exit Date</span>
                            <span className="font-semibold text-slate-300">
                              {pos.exit?.exitDate}
                            </span>
                          </div>
                        )}

                        <div>
                          <span className="text-slate-400 font-sans text-[11px] block">Realized Gross P&amp;L</span>
                          <span
                            className={`font-bold text-sm ${
                              isPositivePnl ? 'text-emerald-400' : 'text-slate-300'
                            }`}
                          >
                            {pos.realizedPnl !== null && pos.realizedPnl !== undefined
                              ? `${pos.realizedPnl >= 0 ? '+' : ''}${formatINR(pos.realizedPnl)}`
                              : '₹--'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        generatePositionPdf(pos, {
                          isDemoMode,
                          userEmail: user?.email,
                          marketDataSource: 'TejHQ Daily EOD',
                        });
                        setToastMessage(`PDF report generated for archived ${pos.symbol}.`);
                        setTimeout(() => setToastMessage(null), 3500);
                      }}
                      icon={<FileDown className="w-3.5 h-3.5" />}
                      title={`Download archived PDF report for ${pos.symbol}`}
                    >
                      Download PDF
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRestore(pos.id, pos.symbol)}
                      disabled={restoringId !== null}
                      title={restoringId === pos.id ? "Restoring position..." : "Restore position to portfolio"}
                      icon={
                        restoringId === pos.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3.5 h-3.5" />
                        )
                      }
                    >
                      {restoringId === pos.id ? 'Restoring...' : 'Restore to Portfolio'}
                    </Button>
                  </div>
                </div>

                {/* Preserved Multi-Entry Table */}
                <div
                  tabIndex={0}
                  role="region"
                  aria-label={`${pos.symbol} Preserved Entries History`}
                  className="overflow-x-auto focus-visible:ring-1 focus-visible:ring-cyan-400 outline-none"
                >
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/90 text-[10px] text-slate-400 uppercase font-sans tracking-wider">
                        <th className="px-5 py-3">Sequence</th>
                        <th className="px-5 py-3">Entry Date</th>
                        <th className="px-5 py-3 text-right">Entry Price</th>
                        <th className="px-5 py-3 text-right">Recorded Stop-Loss</th>
                        <th className="px-5 py-3 text-right">RPS</th>
                        <th className="px-5 py-3 text-right">RPT (1%)</th>
                        <th className="px-5 py-3 text-right">Quantity</th>
                        <th className="px-5 py-3 text-right">Exit Price</th>
                        <th className="px-5 py-3 text-right">Exit Date</th>
                        <th className="px-5 py-3 text-right">Entry P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {pos.entries.map((entry) => {
                        const entryPnl = entry.entryPnl;
                        const isEntryPnlPositive = entryPnl !== null && entryPnl !== undefined && entryPnl >= 0;

                        return (
                          <tr key={entry.id} className="hover:bg-slate-800/30 transition-colors">
                            <td className="px-5 py-3.5 font-sans font-medium text-slate-200">
                              {entry.sequence === 1 ? 'Initial Entry' : `Pyramid #${entry.sequence - 1}`}
                            </td>
                            <td className="px-5 py-3.5 text-slate-300">{entry.entryDate}</td>
                            <td className="px-5 py-3.5 text-right font-bold text-slate-100">{formatINR(entry.entryPrice)}</td>
                            <td className="px-5 py-3.5 text-right text-slate-300">{formatINR(entry.stopLoss)}</td>
                            <td className="px-5 py-3.5 text-right text-emerald-400">+{formatINR(entry.rps)}</td>
                            <td className="px-5 py-3.5 text-right text-cyan-300">{formatINR(entry.rpt)}</td>
                            <td className="px-5 py-3.5 text-right font-bold text-slate-100">{formatShares(entry.quantity)}</td>
                            <td className="px-5 py-3.5 text-right text-slate-300">
                              {hasExit ? formatINR(pos.exit?.exitPrice) : '--'}
                            </td>
                            <td className="px-5 py-3.5 text-right text-slate-300">
                              {hasExit ? pos.exit?.exitDate : '--'}
                            </td>
                            <td className="px-5 py-3.5 text-right font-bold">
                              {entryPnl !== null && entryPnl !== undefined ? (
                                <span className={isEntryPnlPositive ? 'text-emerald-400' : 'text-rose-400'}>
                                  {isEntryPnlPositive ? '+' : ''}{formatINR(entryPnl)}
                                </span>
                              ) : (
                                <span className="text-slate-400 font-sans text-[11px]">--</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="px-5 py-2.5 border-t border-slate-800 bg-slate-950/40 flex items-center justify-between text-[11px] text-slate-400">
                  <span>Archived at: {pos.archivedAt ? new Date(pos.archivedAt).toLocaleString() : 'Historical'}</span>
                  <span className="flex items-center gap-1 font-mono text-cyan-400">
                    <Lock className="w-3 h-3" />
                    Immutable Audit Record
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
