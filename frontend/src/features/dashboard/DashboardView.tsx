import { useState, useEffect, type FC } from 'react';
import {
  Briefcase,
  Layers,
  TrendingUp,
  Archive,
  Sparkles,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import { SummaryCard } from './SummaryCard';
import { StockScreenerPreview } from './StockScreenerPreview';
import { RecentActivitySection } from './RecentActivitySection';
import { TradingRulesBanner } from './TradingRulesBanner';
import { TradeEntryModal } from './TradeEntryModal';
import { Button } from '../../components/common/Button';
import type {
  ScreenerStock,
  MarketSnapshotRead,
  ConstituentScreenResultRead,
} from '../../types/trading';
import { SAMPLE_NSE_STOCKS } from '../../data/mockStocks';
import { usePortfolio } from '../../context/PortfolioContext';
import { formatINR, formatShares } from '../../services/calculations';
import { fetchLargeCapUniverseScreen } from '../../services/api';

function mapConstituentToScreenerStock(c: ConstituentScreenResultRead): ScreenerStock {
  const price = c.lastPrice ?? 0;
  const sma = c.twentyWeekSma ?? 0;
  const rsi = c.weeklyRsi ?? 0;
  return {
    symbol: c.canonicalNseSymbol,
    canonicalSymbol: `${c.canonicalNseSymbol}.NS`,
    displayName: c.companyName,
    exchange: 'NSE',
    isLargeCap: true,
    sector: 'NSE Large-Cap',
    referencePrice: price,
    referencePriceAsOf: c.quoteTimestamp ?? '',
    latestCompletedWeeklyCandleDate: c.latestCompletedCandleDate ?? '',
    twentyWeekSma: sma,
    weeklyRsi: rsi,
    dataSource: 'TejHQ EOD Market Data',
    isStale: c.isStale,
    isEligible: c.isQualified,
    eligibilityReasons: c.isQualified
      ? ['Weekly RSI > 60.0', 'Active AMFI Large-Cap constituent', 'Verified EOD data']
      : [c.diagnosticReason || 'Does not meet qualification criteria'],
    previousClosePrice: price,
    dayChangePercent: 0,
    marketCapRank: c.rank,
  };
}

interface DashboardViewProps {
  onNavigateToScreener: () => void;
  onNavigateToPortfolio: () => void;
  onNavigateToArchived: () => void;
}

export const DashboardView: FC<DashboardViewProps> = ({
  onNavigateToScreener,
  onNavigateToPortfolio,
  onNavigateToArchived,
}) => {
  const { summary, recentActivity, addInitialEntry, isDemoMode, setScreenerQualifiedCount } = usePortfolio();

  const [selectedStockForEntry, setSelectedStockForEntry] = useState<ScreenerStock | null>(null);
  const [isEntryModalOpen, setIsEntryModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [authenticatedStocks, setAuthenticatedStocks] = useState<ScreenerStock[]>([]);

  useEffect(() => {
    if (isDemoMode) {
      setAuthenticatedStocks([]);
      return;
    }

    let isMounted = true;
    fetchLargeCapUniverseScreen(false)
      .then((resp) => {
        if (!isMounted) return;
        setAuthenticatedStocks(resp.results.map(mapConstituentToScreenerStock));
        setScreenerQualifiedCount(resp.qualifiedCount);
      })
      .catch(() => {
        if (!isMounted) return;
        setAuthenticatedStocks([]);
      });

    return () => {
      isMounted = false;
    };
  }, [isDemoMode, setScreenerQualifiedCount]);

  const handleOpenEntry = (stock: ScreenerStock) => {
    setSelectedStockForEntry(stock);
    setIsEntryModalOpen(true);
  };

  const handleConfirmEntry = async (
    stockOrSnapshot: MarketSnapshotRead | ScreenerStock,
    capital: number,
    customStopLossOrNotes?: number | string | any,
    options?: any
  ) => {
    const res = await addInitialEntry(stockOrSnapshot, capital, customStopLossOrNotes, options);
    if (!res.success) {
      setErrorMessage(res.error || 'Failed to record entry');
      return res;
    }

    setToastMessage(
      isDemoMode
        ? `Paper position initialized for ${stockOrSnapshot.symbol} and recorded to active portfolio.`
        : `Position created for ${stockOrSnapshot.symbol} and recorded to active portfolio.`
    );
    setTimeout(() => {
      setToastMessage(null);
    }, 4000);
    return res;
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="p-4 rounded-xl bg-emerald-950 border border-emerald-700 text-emerald-200 text-xs flex items-center justify-between shadow-xl animate-in fade-in duration-200">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>{toastMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            className="text-emerald-400 hover:text-emerald-200 font-bold ml-4"
          >
            ✕
          </button>
        </div>
      )}

      {/* Error Message */}
      {errorMessage && (
        <div className="p-4 rounded-xl bg-rose-950 border border-rose-700 text-rose-200 text-xs flex items-center justify-between shadow-xl">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400" />
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-rose-400 hover:text-rose-200 font-bold ml-4"
          >
            ✕
          </button>
        </div>
      )}

      {/* Welcome & Context Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-black tracking-tight text-slate-100">
              Trading Terminal Overview
            </h2>
            <span className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800">
              NSE Cash
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
            Systematic screening and capital sizing engine based on weekly momentum (RSI &gt; 60) and 20-week completed candle moving averages.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="primary"
            size="sm"
            onClick={onNavigateToScreener}
            icon={<Sparkles className="w-3.5 h-3.5" />}
          >
            Run Candidate Screener
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onNavigateToPortfolio}
          >
            View Portfolio
          </Button>
        </div>
      </div>

      {/* Trading Disciplines Rule Banner */}
      <TradingRulesBanner />

      {/* 4 Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 1. Active Positions */}
        <SummaryCard
          title="Active Positions"
          value={summary.activePositionsCount}
          subValue={`${formatINR(summary.totalCapitalDeployed, false)} capital basis`}
          icon={<Briefcase className="w-5 h-5" />}
          accentColor="cyan"
          trend="neutral"
          footnote="Click to view portfolio"
          onClick={onNavigateToPortfolio}
        />

        {/* 2. Total Quantity */}
        <SummaryCard
          title="Total Quantity"
          value={formatShares(summary.totalQuantity)}
          subValue="Whole shares accumulated"
          icon={<Layers className="w-5 h-5" />}
          accentColor="indigo"
          trend="neutral"
          footnote={`Across ${summary.activePositionsCount} active positions`}
        />

        {/* 3. Realized P&L */}
        <SummaryCard
          title="Realized P&L"
          value={formatINR(summary.realizedPnl)}
          subValue={`${summary.realizedPnl >= 0 ? '+' : ''}${summary.realizedPnlPercent}% across exits`}
          icon={<TrendingUp className="w-5 h-5" />}
          accentColor="emerald"
          trend={summary.realizedPnl >= 0 ? 'up' : 'down'}
          footnote="Excludes transaction costs"
        />

        {/* 4. Archived Positions */}
        <SummaryCard
          title="Archived Positions"
          value={summary.archivedPositionsCount}
          subValue="Preserved historical records"
          icon={<Archive className="w-5 h-5" />}
          accentColor="amber"
          trend="neutral"
          footnote="Click to view archive history"
          onClick={onNavigateToArchived}
        />
      </div>

      {/* Stock Screener Preview Section */}
      <StockScreenerPreview
        stocks={isDemoMode ? SAMPLE_NSE_STOCKS : authenticatedStocks}
        onSelectStock={handleOpenEntry}
        onViewAll={onNavigateToScreener}
        isDemo={isDemoMode}
      />

      {/* Recent Portfolio Activity Section */}
      <RecentActivitySection
        activities={recentActivity}
        onViewAll={onNavigateToPortfolio}
      />

      {/* Trade Entry & Sizing Modal */}
      <TradeEntryModal
        stock={selectedStockForEntry}
        isOpen={isEntryModalOpen}
        onClose={() => setIsEntryModalOpen(false)}
        onConfirmEntry={handleConfirmEntry}
      />
    </div>
  );
};
