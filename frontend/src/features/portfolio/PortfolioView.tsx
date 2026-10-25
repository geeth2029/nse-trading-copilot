import { useState, type FC } from 'react';
import {
  Briefcase,
  Layers,
  LogOut,
  Archive,
  CheckCircle2,
  Loader2,
  RefreshCw,
  AlertTriangle,
  ShieldCheck,
  FileDown,
} from 'lucide-react';
import { usePortfolio } from '../../context/PortfolioContext';
import { useOptionalAuth } from '../../context/AuthContext';
import type { PortfolioPosition } from '../../types/trading';
import { Badge } from '../../components/common/Badge';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { PyramidModal } from './PyramidModal';
import { RecordExitModal } from './RecordExitModal';
import { ArchiveModal } from './ArchiveModal';
import {
  formatINR,
  formatShares,
} from '../../services/calculations';
import {
  generatePositionPdf,
  generatePortfolioPdf,
} from '../../services/pdfReportService';

export const PortfolioView: FC = () => {
  const auth = useOptionalAuth();
  const user = auth?.user;
  const {
    activePositions,
    archivedPositions,
    summary,
    isDemoMode,
    setPortfolioMode,
    isLoadingPortfolio,
    portfolioError,
    refreshPortfolio,
    addPyramidEntry,
    recordPositionExit,
    archivePosition,
    checkPyramidEligibility,
  } = usePortfolio();

  const [selectedForPyramid, setSelectedForPyramid] = useState<PortfolioPosition | null>(null);
  const [selectedForExit, setSelectedForExit] = useState<PortfolioPosition | null>(null);
  const [selectedForArchive, setSelectedForArchive] = useState<PortfolioPosition | null>(null);
  const [notification, setNotification] = useState<string | null>(null);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3500);
  };

  const handleConfirmPyramid = async (
    positionId: string,
    capital: number,
    notesOrOptions?: string | any,
    options?: any
  ) => {
    const res = await addPyramidEntry(positionId, capital, notesOrOptions, options);
    if (res.success) {
      const msg = isDemoMode
        ? 'Paper pyramid entry successfully confirmed and appended to position history.'
        : 'Pyramid entry recorded successfully on server.';
      showNotification(msg);
    } else {
      showNotification(`Pyramid error: ${res.error}`);
    }
    return res;
  };

  const handleConfirmExit = async (
    positionId: string,
    exitPrice: number,
    exitDate: string,
    notes?: string
  ) => {
    const res = await recordPositionExit(positionId, exitPrice, exitDate, notes);
    if (res.success) {
      const msg = isDemoMode
        ? 'Single position exit recorded. Entry-level and consolidated P&L calculated.'
        : 'Position exit recorded successfully on server.';
      showNotification(msg);
    } else {
      showNotification(`Exit error: ${res.error}`);
    }
    return res;
  };

  const handleConfirmArchive = async (positionId: string, reason?: string) => {
    const res = await archivePosition(positionId, reason);
    if (res.success) {
      const msg = isDemoMode
        ? 'Position archived. Complete entry history preserved in Archived Positions.'
        : 'Position archived successfully on server.';
      showNotification(msg);
    } else {
      showNotification(`Archive error: ${res.error}`);
    }
    return res;
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {notification && (
        <div className="p-4 rounded-xl bg-cyan-950 border border-cyan-700 text-cyan-200 text-xs flex items-center justify-between shadow-xl animate-in fade-in duration-200">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-cyan-400" />
            <span>{notification}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotification(null)}
            className="text-cyan-400 hover:text-cyan-200 font-bold ml-4"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Briefcase className="w-5 h-5 text-cyan-400" />
            <span>Active Portfolio Positions</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Individual position tables tracking each entry row, accumulated shares, pyramiding criteria, and single-exit P&amp;L.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              generatePortfolioPdf(activePositions, archivedPositions, summary, {
                isDemoMode,
                userEmail: user?.email,
                marketDataSource: 'TejHQ Daily EOD',
              });
              showNotification(
                isDemoMode
                  ? 'Demo portfolio PDF generated and downloaded.'
                  : 'Portfolio PDF generated and downloaded.'
              );
            }}
            icon={<FileDown className="w-3.5 h-3.5" />}
            title="Download consolidated portfolio PDF report"
          >
            Download Portfolio PDF
          </Button>
          <Badge variant={isDemoMode ? 'warning' : 'success'} size="md">
            {isDemoMode ? 'Demo Mode (Mock Data)' : 'Live Authenticated Portfolio'}
          </Badge>
          <Badge variant="terminal" size="md">
            {activePositions.length} {isDemoMode ? 'Demo Positions' : 'Saved Positions'}
          </Badge>
        </div>
      </div>

      {/* Mode Status Banner */}
      {!isDemoMode ? (
        <div className="p-4 rounded-xl bg-slate-900 border border-emerald-800/50 text-xs text-slate-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
            <div>
              <strong className="text-slate-100 block">Authenticated Portfolio Mode Active</strong>
              <p className="text-slate-400 text-[11px] mt-0.5">
                Positions are fetched directly from your authenticated server database session. Only your saved records are shown.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              onClick={refreshPortfolio}
              disabled={isLoadingPortfolio}
              icon={<RefreshCw className={`w-3.5 h-3.5 ${isLoadingPortfolio ? 'animate-spin' : ''}`} />}
            >
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPortfolioMode('demo')}
            >
              Switch to Demo
            </Button>
          </div>
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-slate-900 border border-amber-800/40 text-xs text-slate-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
            <div>
              <strong className="text-slate-100 block">Demo Simulation Active</strong>
              <p className="text-slate-400 text-[11px] mt-0.5">
                Displaying static paper trading demonstration fixtures. Sizing, pyramiding, and exit calculations work interactively.
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPortfolioMode('authenticated')}
            className="text-cyan-400 hover:text-cyan-300 self-start sm:self-auto"
          >
            Switch to Live Portfolio →
          </Button>
        </div>
      )}

      {/* Core Rules Quick Summary */}
      <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-indigo-950 text-indigo-400 border border-indigo-800 shrink-0">
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <strong className="text-slate-100 block">Pyramiding Rule</strong>
            <p className="text-slate-400 text-[11px] mt-0.5">
              Requires <code>Weekly RSI &gt; 60</code> and <code>Prev Entry Price &lt;= 20W SMA &lt;= Prev Entry Price + 3</code>. Evaluated strictly against the previous entry price in the most recent entry row.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-emerald-950 text-emerald-400 border border-emerald-800 shrink-0">
            <LogOut className="w-4 h-4" />
          </div>
          <div>
            <strong className="text-slate-100 block">Single Position Exit Rule</strong>
            <p className="text-slate-400 text-[11px] mt-0.5">
              One recorded exit applies to the entire accumulated position. Entry P&amp;L = <code>(Exit Price - Entry Price) * Quantity</code>. Total P&amp;L sums entry rows without transaction costs.
            </p>
          </div>
        </div>
      </div>

      {/* Content: Loading, Error, Empty, or Position Cards */}
      {isLoadingPortfolio ? (
        <Card className="text-center py-16">
          <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-200">Loading Portfolio Positions</h3>
          <p className="text-xs text-slate-400 mt-1">
            Retrieving saved portfolio positions from your authenticated server session...
          </p>
        </Card>
      ) : portfolioError ? (
        <Card className="text-center py-12 border-rose-800/60 bg-rose-950/20">
          <AlertTriangle className="w-8 h-8 text-rose-400 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-rose-200">Failed to Load Portfolio</h3>
          <p className="text-xs text-rose-300/80 mt-1 max-w-md mx-auto">
            {portfolioError}
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={refreshPortfolio}
              icon={<RefreshCw className="w-3.5 h-3.5" />}
            >
              Retry
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPortfolioMode('demo')}
            >
              Switch to Demo Mode
            </Button>
          </div>
        </Card>
      ) : activePositions.length === 0 ? (
        <Card className="text-center py-12">
          <Briefcase className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-200">
            {isDemoMode ? 'No Active Positions' : 'No Active Positions in Your Portfolio'}
          </h3>
          <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
            {isDemoMode
              ? 'Use "Let\'s Dive In" on the Dashboard or Stock Screener to initiate paper trade entries.'
              : 'Your authenticated database currently contains zero active positions. Use Demo Mode to explore sample portfolio positions.'}
          </p>
          {!isDemoMode && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPortfolioMode('demo')}
              >
                Switch to Demo Mode
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={refreshPortfolio}
                icon={<RefreshCw className="w-3.5 h-3.5" />}
              >
                Refresh
              </Button>
            </div>
          )}
        </Card>
      ) : (

        /* Each stock has its own dedicated card and entries table! */
        <div className="space-y-6">
          {activePositions.map((position) => {
            const pCheck = checkPyramidEligibility(position);
            const isExited = !!position.exit;
            const entriesCount = position.entries?.length || 0;

            return (
              <div
                key={position.id}
                className="rounded-xl bg-slate-900 border border-slate-800 shadow-xl overflow-hidden"
              >
                {/* Position Header Banner */}
                <div className="p-5 border-b border-slate-800 bg-slate-950/70 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-cyan-400 mt-0.5">
                      <Briefcase className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="text-lg font-bold font-mono text-slate-100">
                          {position.symbol}
                        </span>
                        <span className="text-xs text-slate-400">
                          {position.companyName}
                        </span>
                        <Badge
                          variant={isExited ? 'neutral' : 'info'}
                          size="sm"
                        >
                          {isExited ? 'Closed / Exited' : 'Active Position'}
                        </Badge>
                        <Badge variant="terminal" size="sm">
                          {entriesCount} {entriesCount === 1 ? 'Entry Row' : 'Accumulated Entries'}
                        </Badge>
                      </div>

                      {/* Position Summary Metrics Bar */}
                      <div className="flex items-center gap-4 sm:gap-6 mt-2 text-xs flex-wrap font-mono">
                        <div>
                          <span className="text-slate-400 font-sans text-[11px] block">Accumulated Quantity</span>
                          <span className="font-extrabold text-cyan-400 text-sm">
                            {formatShares(position.accumulatedQuantity)} shares
                          </span>
                        </div>

                        <div>
                          <span className="text-slate-400 font-sans text-[11px] block">Weighted Avg Entry</span>
                          <span className="font-semibold text-slate-200">
                            {formatINR(position.averageEntryPrice)}
                          </span>
                        </div>

                        <div>
                          <span className="text-slate-400 font-sans text-[11px] block">Current Ref Price</span>
                          <span className="font-semibold text-slate-200">
                            {formatINR(position.currentReferencePrice)}
                          </span>
                        </div>

                        <div>
                          <span className="text-slate-400 font-sans text-[11px] block">20W SMA (Stop-Loss)</span>
                          <span className="font-semibold text-slate-400">
                            {formatINR(position.twentyWeekSmaStopLoss)}
                          </span>
                        </div>

                        <div>
                          <span className="text-slate-400 font-sans text-[11px] block">
                            {isExited ? 'Realized P&L' : 'Unrealized P&L'}
                          </span>
                          <span
                            className={`font-bold text-sm ${
                              (isExited ? position.realizedPnl || 0 : position.unrealizedPnl || 0) >= 0
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }`}
                          >
                            {isExited
                              ? (position.realizedPnl !== null && position.realizedPnl !== undefined
                                  ? `${position.realizedPnl >= 0 ? '+' : ''}${formatINR(position.realizedPnl)}`
                                  : '₹--')
                              : (position.unrealizedPnl !== null && position.unrealizedPnl !== undefined
                                  ? `${position.unrealizedPnl >= 0 ? '+' : ''}${formatINR(position.unrealizedPnl)}`
                                  : '₹--')}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Position Actions */}
                  <div className="flex items-center gap-2.5 flex-wrap pt-2 lg:pt-0 border-t lg:border-t-0 border-slate-800">
                    {/* Download Position PDF Button */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        generatePositionPdf(position, {
                          isDemoMode,
                          userEmail: user?.email,
                          marketDataSource: 'TejHQ Daily EOD',
                        });
                        showNotification(`Position PDF report generated for ${position.symbol}.`);
                      }}
                      icon={<FileDown className="w-3.5 h-3.5" />}
                      title={`Download PDF report for ${position.symbol}`}
                    >
                      Download PDF
                    </Button>

                    {/* Pyramid Button */}
                    {!isExited && (
                      <Button
                        variant={pCheck?.isEligible ? 'primary' : 'outline'}
                        size="sm"
                        onClick={() => setSelectedForPyramid(position)}
                        icon={<Layers className="w-3.5 h-3.5" />}
                        title={
                          pCheck?.isEligible
                            ? 'Qualifies for pyramiding'
                            : `Ineligible: ${pCheck?.reasons.join('; ')}`
                        }
                        disabled={!pCheck?.isEligible}
                      >
                        {pCheck?.isEligible ? 'Pyramid (+1)' : 'Pyramid Status'}
                      </Button>
                    )}

                    {/* Record Exit Button */}
                    {!isExited ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setSelectedForExit(position)}
                        icon={<LogOut className="w-3.5 h-3.5" />}
                      >
                        Record Exit
                      </Button>
                    ) : (
                      <Badge variant="success" size="sm">
                        Exited at {formatINR(position.exit?.exitPrice)}
                      </Badge>
                    )}

                    {/* Archive Button */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedForArchive(position)}
                      icon={<Archive className="w-3.5 h-3.5" />}
                      className="text-slate-400 hover:text-amber-400"
                      title="Soft-archive position while preserving all records"
                    >
                      Archive
                    </Button>
                  </div>
                </div>

                {/* Stock's Dedicated Entries Table */}
                <div
                  tabIndex={0}
                  role="region"
                  aria-label={`${position.symbol} Entries History Table`}
                  className="overflow-x-auto focus-visible:ring-1 focus-visible:ring-cyan-400 outline-none"
                >
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/90 text-[10px] text-slate-400 uppercase font-sans tracking-wider">
                        <th className="px-5 py-3">Sequence</th>
                        <th className="px-5 py-3">Entry Date</th>
                        <th className="px-5 py-3 text-right">Entry Price</th>
                        <th className="px-5 py-3 text-right">Stop-Loss (20W SMA)</th>
                        <th className="px-5 py-3 text-right">RPS</th>
                        <th className="px-5 py-3 text-right">RPT (1%)</th>
                        <th className="px-5 py-3 text-right">Quantity</th>
                        <th className="px-5 py-3 text-right">Exit Price</th>
                        <th className="px-5 py-3 text-right">Exit Date</th>
                        <th className="px-5 py-3 text-right">Entry P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {position.entries.map((entry) => {
                        const hasExit = !!position.exit;
                        const entryPnl = entry.entryPnl;
                        const isPositivePnl = entryPnl !== null && entryPnl !== undefined && entryPnl >= 0;

                        return (
                          <tr
                            key={entry.id}
                            className="hover:bg-slate-800/30 transition-colors"
                          >
                            {/* Sequence / Type */}
                            <td className="px-5 py-3.5 font-sans">
                              <span className="font-semibold text-slate-200">
                                {entry.sequence === 1 ? 'Initial Entry' : `Pyramid #${entry.sequence - 1}`}
                              </span>
                            </td>

                            {/* Entry Date */}
                            <td className="px-5 py-3.5 text-slate-300">
                              {entry.entryDate}
                            </td>

                            {/* Entry Price (Reference Price) */}
                            <td className="px-5 py-3.5 text-right font-bold text-slate-100">
                              {formatINR(entry.entryPrice)}
                            </td>

                            {/* Stop-Loss */}
                            <td className="px-5 py-3.5 text-right text-slate-300">
                              {formatINR(entry.stopLoss)}
                            </td>

                            {/* RPS */}
                            <td className="px-5 py-3.5 text-right">
                              <span className={entry.rps > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                {entry.rps > 0 ? `+₹${entry.rps.toFixed(2)}` : `₹${entry.rps.toFixed(2)}`}
                              </span>
                            </td>

                            {/* RPT */}
                            <td className="px-5 py-3.5 text-right text-cyan-300">
                              {formatINR(entry.rpt)}
                            </td>

                            {/* Quantity */}
                            <td className="px-5 py-3.5 text-right font-bold text-slate-100">
                              {entry.quantity !== null ? (
                                formatShares(entry.quantity)
                              ) : (
                                <span className="text-rose-400 font-sans text-[11px]">
                                  Unavailable
                                </span>
                              )}
                            </td>

                            {/* Exit Price */}
                            <td className="px-5 py-3.5 text-right text-slate-300">
                              {hasExit ? formatINR(position.exit?.exitPrice) : <span className="text-slate-400">--</span>}
                            </td>

                            {/* Exit Date */}
                            <td className="px-5 py-3.5 text-right text-slate-300">
                              {hasExit ? position.exit?.exitDate : <span className="text-slate-400">--</span>}
                            </td>

                            {/* Entry P&L */}
                            <td className="px-5 py-3.5 text-right font-bold">
                              {entryPnl !== null && entryPnl !== undefined ? (
                                <span className={isPositivePnl ? 'text-emerald-400' : 'text-rose-400'}>
                                  {isPositivePnl ? '+' : ''}{formatINR(entryPnl)}
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

                {/* Table Footer */}
                <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/40 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-400 gap-2">
                  <span>
                    Total Accumulated Quantity: <strong className="text-cyan-300 font-mono">{formatShares(position.accumulatedQuantity)} shares</strong> • Capital Deployed: <strong className="text-slate-200 font-mono">{formatINR(position.totalCapitalDeployed)}</strong>
                  </span>
                  <span className="text-[11px] text-slate-400">
                    Immutable snapshot records • Reference quotes only
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pyramiding Review Modal */}
      <PyramidModal
        position={selectedForPyramid}
        isOpen={!!selectedForPyramid}
        onClose={() => setSelectedForPyramid(null)}
        onConfirmPyramid={handleConfirmPyramid}
      />

      {/* Single Exit Recording Modal */}
      <RecordExitModal
        position={selectedForExit}
        isOpen={!!selectedForExit}
        onClose={() => setSelectedForExit(null)}
        onConfirmExit={handleConfirmExit}
      />

      {/* Archive Position Confirmation Modal */}
      <ArchiveModal
        position={selectedForArchive}
        isOpen={!!selectedForArchive}
        onClose={() => setSelectedForArchive(null)}
        onConfirmArchive={handleConfirmArchive}
      />
    </div>
  );
};
