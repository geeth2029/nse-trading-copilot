import { useState, useEffect, useMemo, useCallback, type FC } from 'react';
import {
  Filter,
  Search,
  ArrowUpRight,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Database,
  Calendar,
} from 'lucide-react';
import type {
  ScreenerStock,
  MarketSnapshotRead,
  UniverseStatusRead,
  UniverseScreenResponse,
  ConstituentScreenResultRead,
} from '../../types/trading';
import { SAMPLE_NSE_STOCKS } from '../../data/mockStocks';
import { usePortfolio } from '../../context/PortfolioContext';
import { Badge } from '../../components/common/Badge';
import { Button } from '../../components/common/Button';
import { TradeEntryModal } from '../dashboard/TradeEntryModal';
import { formatINR } from '../../services/calculations';
import {
  fetchMarketSnapshot,
  fetchLargeCapUniverseStatus,
  fetchLargeCapUniverseScreen,
} from '../../services/api';

function getMarketDataLabel(source?: string | null): string {
  if (!source) return 'TejHQ EOD market data';
  const upper = source.trim().toUpperCase();
  if (upper === 'TEJHQ' || upper === 'TEJ') return 'TejHQ EOD market data';
  if (upper === 'UPSTOX') return 'Upstox market data';
  return `${source} market data`;
}

function getProviderShortLabel(source?: string | null): string {
  if (!source) return 'TejHQ EOD';
  const upper = source.trim().toUpperCase();
  if (upper === 'TEJHQ' || upper === 'TEJ') return 'TejHQ EOD';
  if (upper === 'UPSTOX') return 'Upstox';
  return source;
}

function getProviderSourceText(source?: string | null): string {
  const upper = (source || '').trim().toUpperCase();
  if (upper === 'UPSTOX') return 'Upstox API (NSE Large-Cap Screener)';
  return 'TejHQ EOD Market Data (NSE Large-Cap Screener)';
}

export const ScreenerView: FC = () => {
  const { addInitialEntry, isDemoMode, setScreenerQualifiedCount } = usePortfolio();

  // -------------------------------------------------------------
  // Demo Mode State
  // -------------------------------------------------------------
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSector, setSelectedSector] = useState<string>('ALL');
  const [filterEligibility, setFilterEligibility] = useState<'ALL' | 'ELIGIBLE' | 'INELIGIBLE'>('ALL');
  const [selectedStock, setSelectedStock] = useState<ScreenerStock | null>(null);

  // -------------------------------------------------------------
  // Authenticated Large-Cap Universe Screener State
  // -------------------------------------------------------------
  const [universeStatus, setUniverseStatus] = useState<UniverseStatusRead | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState<boolean>(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [screenResponse, setScreenResponse] = useState<UniverseScreenResponse | null>(null);
  const [isLoadingScreen, setIsLoadingScreen] = useState<boolean>(false);
  const [screenError, setScreenError] = useState<string | null>(null);

  const [qualifiedOnlyFilter, setQualifiedOnlyFilter] = useState<boolean>(false);
  const [constituentSearch, setConstituentSearch] = useState<string>('');

  // -------------------------------------------------------------
  // Authenticated Individual Symbol Lookup State
  // -------------------------------------------------------------
  const [lookupSymbol, setLookupSymbol] = useState('');
  const [isLoadingLookup, setIsLoadingLookup] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<MarketSnapshotRead | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<MarketSnapshotRead | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);

  const activeSource = useMemo(() => {
    return screenResponse?.marketDataSource || snapshot?.source || null;
  }, [screenResponse, snapshot]);

  // -------------------------------------------------------------
  // Data Loading: Authenticated Universe Status & Screen
  // -------------------------------------------------------------
  const loadScreenResults = useCallback(async (qualifiedOnly: boolean) => {
    setIsLoadingScreen(true);
    setScreenError(null);
    try {
      const resp = await fetchLargeCapUniverseScreen(qualifiedOnly);
      setScreenResponse(resp);
      setScreenerQualifiedCount(resp.qualifiedCount);
    } catch (err: unknown) {
      setScreenResponse(null);
      setScreenError(
        err instanceof Error ? err.message : 'Failed to retrieve universe screening results.'
      );
    } finally {
      setIsLoadingScreen(false);
    }
  }, [setScreenerQualifiedCount]);

  const loadUniverseStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    setStatusError(null);
    try {
      const status = await fetchLargeCapUniverseStatus();
      setUniverseStatus(status);
      if (status.status === 'VALID') {
        await loadScreenResults(qualifiedOnlyFilter);
      } else {
        setScreenResponse(null);
        setScreenerQualifiedCount(0);
      }
    } catch (err: unknown) {
      setUniverseStatus(null);
      setScreenResponse(null);
      setStatusError(
        err instanceof Error ? err.message : 'Failed to retrieve universe status.'
      );
    } finally {
      setIsLoadingStatus(false);
    }
  }, [qualifiedOnlyFilter, loadScreenResults, setScreenerQualifiedCount]);

  useEffect(() => {
    if (!isDemoMode) {
      void loadUniverseStatus();
    }
  }, [isDemoMode, loadUniverseStatus]);

  const handleToggleQualifiedOnly = (qualifiedOnly: boolean) => {
    setQualifiedOnlyFilter(qualifiedOnly);
    if (universeStatus?.status === 'VALID') {
      void loadScreenResults(qualifiedOnly);
    }
  };

  const handleRefreshUniverse = () => {
    void loadUniverseStatus();
  };

  // -------------------------------------------------------------
  // Individual Symbol Lookup Handler
  // -------------------------------------------------------------
  const handleLookup = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = lookupSymbol.trim().toUpperCase();
    if (!clean) return;

    setIsLoadingLookup(true);
    setLookupError(null);

    try {
      const data = await fetchMarketSnapshot(clean);
      setSnapshot(data);
    } catch (err: unknown) {
      setSnapshot(null);
      setLookupError(err instanceof Error ? err.message : `Failed to lookup symbol ${clean}.`);
    } finally {
      setIsLoadingLookup(false);
    }
  };

  // -------------------------------------------------------------
  // Trade Entry Triggers
  // -------------------------------------------------------------
  const handleOpenDemoEntry = (stock: ScreenerStock) => {
    setSelectedStock(stock);
    setSelectedSnapshot(null);
    setIsModalOpen(true);
  };

  const handleOpenSnapshotEntry = (snap: MarketSnapshotRead) => {
    setSelectedSnapshot(snap);
    setSelectedStock(null);
    setIsModalOpen(true);
  };

  const handleOpenConstituentEntry = (c: ConstituentScreenResultRead) => {
    if (!c.isQualified || c.isStale || c.lastPrice === null) return;
    const snap: MarketSnapshotRead = {
      symbol: c.canonicalNseSymbol,
      instrumentIdentifier: c.upstoxInstrumentKey,
      lastPrice: c.lastPrice,
      quoteTimestamp: c.quoteTimestamp || '',
      twentyWeekSma: c.twentyWeekSma,
      weeklyRsi: c.weeklyRsi,
      latestCompletedCandleDate: c.latestCompletedCandleDate,
      completedCandlesCount: 50,
      isStale: c.isStale,
      isEligibleForInitial: c.isQualified,
      statusReason: c.diagnosticReason || 'Qualified: Weekly RSI > 60',
      source: getProviderSourceText(activeSource),
    };
    setSelectedSnapshot(snap);
    setSelectedStock(null);
    setIsModalOpen(true);
  };

  // -------------------------------------------------------------
  // Demo Mode Helpers
  // -------------------------------------------------------------
  const sectors = useMemo(() => {
    const list = Array.from(new Set(SAMPLE_NSE_STOCKS.map((s) => s.sector || 'Other')));
    return ['ALL', ...list];
  }, []);

  const filteredDemoStocks = useMemo(() => {
    return SAMPLE_NSE_STOCKS.filter((stock) => {
      const matchesSearch =
        stock.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
        stock.displayName.toLowerCase().includes(searchQuery.toLowerCase());
      if (!matchesSearch) return false;

      if (selectedSector !== 'ALL' && stock.sector !== selectedSector) return false;

      if (filterEligibility === 'ELIGIBLE' && !stock.isEligible) return false;
      if (filterEligibility === 'INELIGIBLE' && stock.isEligible) return false;

      return true;
    });
  }, [searchQuery, selectedSector, filterEligibility]);

  // Filtered authenticated constituents based on client-side search text
  const filteredConstituents = useMemo(() => {
    if (!screenResponse?.results) return [];
    if (!constituentSearch.trim()) return screenResponse.results;
    const q = constituentSearch.trim().toLowerCase();
    return screenResponse.results.filter(
      (c) =>
        c.canonicalNseSymbol.toLowerCase().includes(q) ||
        c.companyName.toLowerCase().includes(q) ||
        c.isin.toLowerCase().includes(q)
    );
  }, [screenResponse, constituentSearch]);

  // =============================================================
  // Authenticated Portfolio Mode
  // =============================================================
  if (!isDemoMode) {
    return (
      <div className="space-y-8">
        {/* Top Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
              <Filter className="w-5 h-5 text-cyan-400" />
              <span>Verified NSE Market Data • Large-Cap Screener</span>
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Authoritative screening against the verified NSE Large-Cap Universe with{' '}
              {getMarketDataLabel(activeSource)}.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Market Data Provider Verification Badge */}
            {isLoadingStatus || isLoadingScreen ? (
              <Badge variant="warning" size="md">
                Verifying Provider...
              </Badge>
            ) : screenError || statusError ? (
              <Badge variant="danger" size="md">
                Provider Error
              </Badge>
            ) : universeStatus?.status !== 'VALID' ? (
              <Badge variant="danger" size="md">
                Data Unavailable
              </Badge>
            ) : screenResponse && screenResponse.results.length > 0 && screenResponse.results.some((r) => r.isStale) ? (
              <Badge variant="warning" size="md" dot>
                Stale Data
              </Badge>
            ) : screenResponse && universeStatus?.status === 'VALID' ? (
              <Badge variant="success" size="md" dot>
                Verified {getProviderShortLabel(activeSource)}
              </Badge>
            ) : (
              <Badge variant="neutral" size="md">
                Provider Pending
              </Badge>
            )}
            <Badge
              variant={
                isLoadingStatus
                  ? 'warning'
                  : universeStatus?.status === 'VALID'
                  ? 'success'
                  : 'danger'
              }
              size="md"
            >
              {isLoadingStatus
                ? 'Verifying Universe...'
                : universeStatus?.status === 'VALID'
                ? 'Large-Cap Universe Active'
                : `Universe ${universeStatus?.status || 'Unavailable'}`}
            </Badge>
          </div>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* Section 1: Large-Cap Universe Screener                         */}
        {/* ------------------------------------------------------------- */}
        <section aria-label="Large-Cap Universe Screener" className="space-y-4">
          {/* Status Loading State */}
          {isLoadingStatus && (
            <div className="p-8 rounded-xl bg-slate-900 border border-slate-800 text-center space-y-3">
              <Loader2 className="w-6 h-6 animate-spin text-cyan-400 mx-auto" />
              <p className="text-xs font-medium text-slate-200">
                Checking large-cap universe status and cryptographic integrity...
              </p>
              <p className="text-[11px] text-slate-400">
                Verifying sidecar manifest and active classification period.
              </p>
            </div>
          )}

          {/* Status Fetch Error Alert */}
          {statusError && !isLoadingStatus && (
            <div
              role="alert"
              className="p-4 rounded-xl bg-rose-950/60 border border-rose-800 text-xs text-rose-300 flex items-start justify-between gap-3"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-rose-200 block">Universe Status Request Failed</strong>
                  <p className="text-rose-300/90 mt-0.5 leading-relaxed">{statusError}</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshUniverse}
                icon={<RefreshCw className="w-3 h-3" />}
                className="border-rose-700 text-rose-200 shrink-0"
              >
                Retry
              </Button>
            </div>
          )}

          {/* Universe Non-Valid Status Banner (UNAVAILABLE, INVALID, EXPIRED, NOT_YET_ACTIVE) */}
          {!isLoadingStatus && universeStatus && universeStatus.status !== 'VALID' && (
            <div
              role="alert"
              className="p-5 rounded-xl bg-slate-900 border border-amber-800/80 text-xs space-y-3 shadow-lg"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-100">
                      Large-Cap Universe Not Active ({universeStatus.status})
                    </span>
                    <Badge variant="warning" size="sm">
                      {universeStatus.status}
                    </Badge>
                  </div>
                  <p className="text-slate-300 leading-relaxed text-xs">
                    {universeStatus.statusReason}
                  </p>
                  {(universeStatus.classificationPeriod || universeStatus.datasetVersion) && (
                    <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-400 pt-1">
                      {universeStatus.datasetVersion && (
                        <span>Dataset: <strong className="font-mono text-slate-300">{universeStatus.datasetVersion}</strong></span>
                      )}
                      {universeStatus.classificationPeriod && (
                        <span>Period: <strong className="text-slate-300">{universeStatus.classificationPeriod}</strong></span>
                      )}
                      {universeStatus.effectiveFrom && universeStatus.effectiveTo && (
                        <span>Effective: <strong className="text-slate-300">{universeStatus.effectiveFrom} to {universeStatus.effectiveTo}</strong></span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                <p className="text-[11px] text-slate-400">
                  Bulk universe screening requires a verified active classification dataset. Individual symbol lookup below remains fully operational.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefreshUniverse}
                  icon={<RefreshCw className="w-3 h-3" />}
                >
                  Re-check Universe
                </Button>
              </div>
            </div>
          )}

          {/* Valid Universe Active Screener View */}
          {!isLoadingStatus && universeStatus?.status === 'VALID' && (
            <div className="space-y-4">
              {/* Universe Metadata & Controls Header Card */}
              <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-sm">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-semibold text-slate-200">
                      Universe: {universeStatus.datasetVersion || 'NSE Large-Cap'} ({universeStatus.classificationPeriod})
                    </span>
                    <Badge variant="success" size="sm">
                      Active
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-slate-400" />
                      {universeStatus.sourcePeriodLabel || universeStatus.classificationPeriod}
                    </span>
                    {screenResponse && (
                      <span>
                        Evaluated: <span className="font-mono text-slate-300">{new Date(screenResponse.evaluatedAt).toLocaleTimeString()}</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Filter and Refresh Controls */}
                <div className="flex flex-wrap items-center gap-2 self-stretch md:self-auto">
                  {/* All vs Qualified Only Filter Tabs */}
                  <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
                    <button
                      type="button"
                      onClick={() => handleToggleQualifiedOnly(false)}
                      className={`px-3 py-1 rounded font-medium transition-colors ${
                        !qualifiedOnlyFilter
                          ? 'bg-slate-800 text-slate-100 shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      All ({screenResponse?.totalConstituents ?? universeStatus.constituentCount ?? 100})
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleQualifiedOnly(true)}
                      className={`px-3 py-1 rounded font-medium transition-colors ${
                        qualifiedOnlyFilter
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-800 shadow-sm'
                          : 'text-slate-400 hover:text-emerald-400'
                      }`}
                    >
                      Qualified Only ({screenResponse?.qualifiedCount ?? 0})
                    </button>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadScreenResults(qualifiedOnlyFilter)}
                    disabled={isLoadingScreen}
                    icon={<RefreshCw className={`w-3.5 h-3.5 ${isLoadingScreen ? 'animate-spin text-cyan-400' : ''}`} />}
                  >
                    Refresh
                  </Button>
                </div>
              </div>

              {/* Table Search Bar */}
              <div className="flex items-center justify-between gap-3">
                <div className="relative flex-1 max-w-sm">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={constituentSearch}
                    onChange={(e) => setConstituentSearch(e.target.value)}
                    placeholder="Filter loaded constituents (symbol, company, ISIN)..."
                    className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-400"
                  />
                </div>
                <div className="text-[11px] text-slate-400">
                  Showing <strong className="text-slate-200">{filteredConstituents.length}</strong> of{' '}
                  <strong className="text-slate-200">{screenResponse?.results.length ?? 0}</strong> results
                </div>
              </div>

              {/* Screening Error Alert */}
              {screenError && (
                <div
                  role="alert"
                  className="p-4 rounded-xl bg-rose-950/60 border border-rose-800 text-xs text-rose-300 flex items-start justify-between gap-3"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <div>
                      <strong className="text-rose-200 block">Screening Request Failed</strong>
                      <p className="text-rose-300/90 mt-0.5 leading-relaxed">{screenError}</p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadScreenResults(qualifiedOnlyFilter)}
                    icon={<RefreshCw className="w-3 h-3" />}
                    className="border-rose-700 text-rose-200 shrink-0"
                  >
                    Retry
                  </Button>
                </div>
              )}

              {/* Loading Screen State */}
              {isLoadingScreen && (
                <div className="p-8 rounded-xl bg-slate-900 border border-slate-800 text-center space-y-3">
                  <Loader2 className="w-6 h-6 animate-spin text-cyan-400 mx-auto" />
                  <p className="text-xs font-medium text-slate-200">
                    Evaluating large-cap constituents against market indicators...
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Retrieving batch quotes and deriving 20w SMA and weekly RSI.
                  </p>
                </div>
              )}

              {/* Universe Screening Results Table */}
              {!isLoadingScreen && screenResponse && (
                <div
                  tabIndex={0}
                  role="region"
                  aria-label="Verified Large-Cap Screener Table"
                  className="rounded-xl bg-slate-900 border border-slate-800 overflow-x-auto shadow-xl"
                >
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                        <th className="px-4 py-3.5">Rank &amp; Symbol</th>
                        <th className="px-4 py-3.5">Company Name</th>
                        <th className="px-4 py-3.5 text-right">Reference Price</th>
                        <th className="px-4 py-3.5 text-right">20-Week SMA</th>
                        <th className="px-4 py-3.5 text-right">Weekly RSI</th>
                        <th className="px-4 py-3.5 text-center">Freshness</th>
                        <th className="px-4 py-3.5 text-center">Qualification</th>
                        <th className="px-4 py-3.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {filteredConstituents.map((c) => {
                        const hasRsi = c.weeklyRsi !== null;
                        const isRsiPassing = hasRsi && c.weeklyRsi! > 60.0;
                        const formattedPrice = c.lastPrice !== null ? formatINR(c.lastPrice) : '--';
                        const formattedSma = c.twentyWeekSma !== null ? formatINR(c.twentyWeekSma) : '--';
                        const formattedRsi = c.weeklyRsi !== null ? c.weeklyRsi.toFixed(1) : '--';

                        return (
                          <tr key={c.canonicalNseSymbol} className="hover:bg-slate-800/40 transition-colors">
                            {/* Rank & Symbol */}
                            <td className="px-4 py-3.5 font-mono">
                              <div className="flex items-center gap-2">
                                <span className="text-slate-400 text-[10px] w-6">#{c.rank}</span>
                                <span className="font-bold text-sm text-slate-100">{c.canonicalNseSymbol}</span>
                              </div>
                            </td>

                            {/* Company Name & ISIN */}
                            <td className="px-4 py-3.5 max-w-[220px]">
                              <span className="font-medium text-slate-200 block truncate" title={c.companyName}>
                                {c.companyName}
                              </span>
                              <span className="text-[10px] font-mono text-slate-400 block truncate">
                                {c.isin}
                              </span>
                            </td>

                            {/* Reference Price */}
                            <td className="px-4 py-3.5 text-right font-mono font-semibold text-cyan-400">
                              {formattedPrice}
                            </td>

                            {/* 20-Week SMA */}
                            <td className="px-4 py-3.5 text-right font-mono text-slate-300">
                              {formattedSma}
                            </td>

                            {/* Weekly RSI */}
                            <td className="px-4 py-3.5 text-right font-mono">
                              <span
                                className={`font-bold ${
                                  isRsiPassing
                                    ? 'text-emerald-400'
                                    : hasRsi
                                    ? 'text-rose-400'
                                    : 'text-slate-400'
                                }`}
                              >
                                {formattedRsi}
                              </span>
                            </td>

                            {/* Data Freshness */}
                            <td className="px-4 py-3.5 text-center">
                              <Badge variant={c.isStale ? 'warning' : 'success'} size="sm" dot>
                                {c.isStale ? 'Stale' : 'Fresh'}
                              </Badge>
                            </td>

                            {/* Qualification Status & Diagnostic Reason */}
                            <td className="px-4 py-3.5 text-center">
                              {c.isQualified ? (
                                <div className="inline-flex flex-col items-center">
                                  <Badge variant="success" size="sm" dot>
                                    Qualified
                                  </Badge>
                                  <span className="text-[10px] text-emerald-400/90 mt-0.5">RSI &gt; 60</span>
                                </div>
                              ) : (
                                <div className="inline-flex flex-col items-center">
                                  <Badge
                                    variant={
                                      c.diagnosticStatus === 'STALE_QUOTE'
                                        ? 'warning'
                                        : c.diagnosticStatus === 'INSUFFICIENT_HISTORY'
                                        ? 'warning'
                                        : 'neutral'
                                    }
                                    size="sm"
                                  >
                                    {c.diagnosticStatus === 'NOT_QUALIFIED'
                                      ? 'RSI ≤ 60'
                                      : c.diagnosticStatus === 'STALE_QUOTE'
                                      ? 'Stale Quote'
                                      : c.diagnosticStatus === 'INSUFFICIENT_HISTORY'
                                      ? 'Insufficient Bars'
                                      : c.diagnosticStatus === 'QUOTE_UNAVAILABLE'
                                      ? 'No Quote'
                                      : c.diagnosticStatus === 'PROVIDER_ERROR'
                                      ? 'Provider Err'
                                      : 'Unavailable'}
                                  </Badge>
                                  {c.diagnosticReason && (
                                    <span
                                      className="text-[9px] text-slate-400 mt-0.5 max-w-[120px] truncate block"
                                      title={c.diagnosticReason}
                                    >
                                      {c.diagnosticReason}
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>

                            {/* Action Button */}
                            <td className="px-4 py-3.5 text-right">
                              {c.isQualified && !c.isStale && c.lastPrice !== null ? (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => handleOpenConstituentEntry(c)}
                                  icon={<ArrowUpRight className="w-3.5 h-3.5" />}
                                  iconPosition="right"
                                >
                                  Open Entry
                                </Button>
                              ) : (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled
                                  className="opacity-50 cursor-not-allowed"
                                >
                                  {c.isStale
                                    ? 'Stale Quote'
                                    : !hasRsi || (c.weeklyRsi !== null && c.weeklyRsi <= 60.0)
                                    ? 'RSI ≤ 60'
                                    : 'Ineligible'}
                                </Button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ------------------------------------------------------------- */}
        {/* Section 2: Independent Individual Symbol Lookup                */}
        {/* ------------------------------------------------------------- */}
        <section aria-label="Individual Symbol Lookup" className="pt-6 border-t border-slate-800/80 space-y-4">
          <div>
            <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <Search className="w-4 h-4 text-cyan-400" />
              <span>Verified NSE Market Data • Symbol Lookup</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Individual Symbol Lookup Mode: Query any individual NSE equity cash symbol directly from the verified{' '}
              {getProviderShortLabel(snapshot?.source || activeSource)} provider, independent of the large-cap universe.
            </p>
          </div>

          {/* Symbol Search Bar */}
          <form onSubmit={handleLookup} className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
            <label htmlFor="symbol-lookup-input" className="block text-xs font-semibold text-slate-200">
              Query NSE Equity Symbol
            </label>
            <div className="flex flex-col sm:flex-row items-center gap-3">
              <div className="relative flex-1 w-full">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  id="symbol-lookup-input"
                  type="text"
                  value={lookupSymbol}
                  onChange={(e) => setLookupSymbol(e.target.value.toUpperCase())}
                  placeholder="Enter NSE Symbol (e.g. RELIANCE, TCS, INFY, HDFCBANK)..."
                  disabled={isLoadingLookup}
                  className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-sm font-mono text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
                />
              </div>
              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={isLoadingLookup || !lookupSymbol.trim()}
                icon={
                  isLoadingLookup ? (
                    <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )
                }
                className="w-full sm:w-auto"
              >
                {isLoadingLookup ? 'Fetching Snapshot...' : 'Lookup Symbol'}
              </Button>
            </div>
            <p className="text-[11px] text-slate-400">
              Queries live NSE cash market reference quote and calculates 20-week SMA and weekly RSI from completed weekly bars.
            </p>
          </form>

          {/* Lookup Error Alert */}
          {lookupError && (
            <div
              role="alert"
              className="p-4 rounded-xl bg-rose-950/60 border border-rose-800 text-xs text-rose-300 flex items-start justify-between gap-3"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-rose-200 block">Market Data Lookup Failed</strong>
                  <p className="text-rose-300/90 mt-0.5 leading-relaxed">{lookupError}</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleLookup()}
                icon={<RefreshCw className="w-3 h-3" />}
                className="border-rose-700 text-rose-200 shrink-0"
              >
                Retry
              </Button>
            </div>
          )}

          {/* Verified Market Snapshot Card */}
          {snapshot && (
            <div className="rounded-xl bg-slate-900 border border-slate-800 p-5 space-y-4 shadow-xl">
              {/* Snapshot Card Header */}
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold font-mono text-slate-100">{snapshot.symbol}</span>
                    <Badge variant="terminal" size="sm">
                      {snapshot.instrumentIdentifier}
                    </Badge>
                    <Badge variant="neutral" size="sm">
                      {snapshot.source}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    Quote Timestamp: <span className="font-mono text-slate-300">{snapshot.quoteTimestamp}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant={snapshot.isStale ? 'warning' : 'success'} size="sm" dot>
                    {snapshot.isStale ? 'Stale Quote' : 'Live / Fresh'}
                  </Badge>
                  {snapshot.isEligibleForInitial ? (
                    <Badge variant="success" size="sm" dot>
                      Qualified for Initial Entry
                    </Badge>
                  ) : (
                    <Badge variant="danger" size="sm">
                      Not Qualified
                    </Badge>
                  )}
                </div>
              </div>

              {/* Metrics Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {/* Reference Price */}
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <span className="text-slate-400 text-[11px] block">Reference Price</span>
                  <span className="text-xl font-bold font-mono text-cyan-400">
                    {formatINR(snapshot.lastPrice)}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-1">Live NSE Equity Quote</span>
                </div>

                {/* 20-Week SMA */}
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <span className="text-slate-400 text-[11px] block">20-Week Completed SMA</span>
                  <span className="text-xl font-bold font-mono text-slate-200">
                    {snapshot.twentyWeekSma !== null ? formatINR(snapshot.twentyWeekSma) : 'Unavailable'}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-1">
                    Bar Date: {snapshot.latestCompletedCandleDate || 'N/A'}
                  </span>
                </div>

                {/* Weekly RSI */}
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400 text-[11px]">Weekly RSI</span>
                    {snapshot.weeklyRsi !== null && snapshot.weeklyRsi > 60.0 ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-rose-400" />
                    )}
                  </div>
                  <span
                    className={`text-xl font-bold font-mono ${
                      snapshot.weeklyRsi !== null && snapshot.weeklyRsi > 60.0
                        ? 'text-emerald-400'
                        : 'text-rose-400'
                    }`}
                  >
                    {snapshot.weeklyRsi !== null ? snapshot.weeklyRsi.toFixed(1) : 'Unavailable'}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-1">
                    {snapshot.weeklyRsi !== null && snapshot.weeklyRsi > 60.0
                      ? '✓ Strict > 60.0 PASS'
                      : '✗ Must be > 60.0'}
                  </span>
                </div>

                {/* Weekly Candle History */}
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <span className="text-slate-400 text-[11px] block">Completed Weekly History</span>
                  <span className="text-xl font-bold font-mono text-slate-200">
                    {snapshot.completedCandlesCount} bars
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-1">
                    {snapshot.completedCandlesCount >= 20 ? '✓ History Sufficient' : '✗ Minimum 20 Required'}
                  </span>
                </div>
              </div>

              {/* Status Reason Explanation */}
              {snapshot.statusReason && (
                <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800/80 text-xs text-slate-300">
                  <span className="font-semibold text-slate-200 block mb-0.5">Eligibility Assessment:</span>
                  <p className="text-slate-400 text-[11px]">{snapshot.statusReason}</p>
                </div>
              )}

              {/* Stale Warning Banner */}
              {snapshot.isStale && (
                <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-800/60 text-xs text-amber-300 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Quote is stale. New trading entries cannot be opened with stale market data.</span>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-2">
                {snapshot.isEligibleForInitial && !snapshot.isStale ? (
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => handleOpenSnapshotEntry(snapshot)}
                    icon={<ArrowUpRight className="w-4 h-4" />}
                    iconPosition="right"
                  >
                    Open Initial Position
                  </Button>
                ) : (
                  <Button variant="secondary" size="md" disabled>
                    {snapshot.isStale
                      ? 'Entry Disabled (Stale Data)'
                      : snapshot.weeklyRsi === null || snapshot.weeklyRsi <= 60.0
                      ? 'Entry Disabled (RSI ≤ 60)'
                      : snapshot.twentyWeekSma === null
                      ? 'Entry Disabled (SMA Unavailable)'
                      : 'Entry Ineligible'}
                  </Button>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Trade Entry Modal */}
        <TradeEntryModal
          stock={selectedStock}
          snapshot={selectedSnapshot}
          isOpen={isModalOpen}
          onClose={() => {
            setIsModalOpen(false);
            setSelectedSnapshot(null);
            setSelectedStock(null);
          }}
          onConfirmEntry={async (stockOrSnapshot, capital, customStopLossOrNotes, options) => {
            return await addInitialEntry(stockOrSnapshot, capital, customStopLossOrNotes, options);
          }}
        />
      </div>
    );
  }

  // =============================================================
  // Demo Mode: Paper-Trading Screener with Sample Fixtures
  // =============================================================
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Filter className="w-5 h-5 text-cyan-400" />
            <span>NSE Large-Cap Stock Screener (Demo Mode)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Real-time filter evaluation based on weekly indicators from the latest completed candle.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant="warning" size="md">
            Sample Data
          </Badge>
          <Badge variant="terminal" size="md">
            Demo Universe (Sample Data) ({SAMPLE_NSE_STOCKS.length} Stocks)
          </Badge>
        </div>
      </div>

      {/* Sample / Demo Data Notice */}
      <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/60 text-xs text-amber-300 flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold text-amber-200">Sample Simulation Data: </span>
          <span className="text-amber-300/90 leading-relaxed">
            All prices, 20-week SMAs, and weekly RSIs shown in this screener are sample mock fixtures for demonstration and paper-trading simulation. Live verified NSE market data has not yet been connected. Switch to Authenticated Portfolio Mode to query live verified symbols.
          </span>
        </div>
      </div>

      {/* Screener Rule Banner */}
      <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <strong className="text-slate-100 block">Weekly RSI &gt; 60.0</strong>
            <span className="text-slate-400 text-[11px]">
              Strict momentum threshold. Evaluated against closed weekly candle.
            </span>
          </div>
        </div>

        <div className="flex items-start gap-2.5">
          <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
          <div>
            <strong className="text-slate-100 block">20-Week Completed SMA</strong>
            <span className="text-slate-400 text-[11px]">
              Stop-loss baseline calculated from the completed weekly bar (2026-10-16).
            </span>
          </div>
        </div>

        <div className="flex items-start gap-2.5">
          <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <strong className="text-slate-100 block">AMFI Large-Cap Universe</strong>
            <span className="text-slate-400 text-[11px]">
              Ranked 1–100 by full market capitalization.
            </span>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="relative min-w-[240px] flex-1 sm:flex-none">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search stock symbol or name..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Sector filter */}
          <select
            value={selectedSector}
            onChange={(e) => setSelectedSector(e.target.value)}
            className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-cyan-400"
          >
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s === 'ALL' ? 'All Sectors' : s}
              </option>
            ))}
          </select>

          {/* Eligibility Filter */}
          <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800">
            <button
              type="button"
              onClick={() => setFilterEligibility('ALL')}
              className={`px-3 py-1 rounded font-medium transition-colors ${
                filterEligibility === 'ALL'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setFilterEligibility('ELIGIBLE')}
              className={`px-3 py-1 rounded font-medium transition-colors ${
                filterEligibility === 'ELIGIBLE'
                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                  : 'text-slate-400 hover:text-emerald-400'
              }`}
            >
              Eligible Only
            </button>
            <button
              type="button"
              onClick={() => setFilterEligibility('INELIGIBLE')}
              className={`px-3 py-1 rounded font-medium transition-colors ${
                filterEligibility === 'INELIGIBLE'
                  ? 'bg-slate-800 text-slate-200'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Ineligible
            </button>
          </div>
        </div>
      </div>

      {/* Full Screener Table */}
      <div
        tabIndex={0}
        role="region"
        aria-label="Full NSE Screener Table"
        className="rounded-xl bg-slate-900 border border-slate-800 overflow-x-auto shadow-xl"
      >
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-950 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              <th className="px-5 py-3.5">Rank &amp; Symbol</th>
              <th className="px-5 py-3.5">Company &amp; Sector</th>
              <th className="px-5 py-3.5 text-right">Reference Price</th>
              <th className="px-5 py-3.5 text-right">Weekly RSI</th>
              <th className="px-5 py-3.5 text-right">20-Week SMA</th>
              <th className="px-5 py-3.5 text-center">Eligibility</th>
              <th className="px-5 py-3.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {filteredDemoStocks.map((stock) => {
              const isRsiPassing = stock.weeklyRsi > 60.0;
              return (
                <tr key={stock.symbol} className="hover:bg-slate-800/40 transition-colors">
                  <td className="px-5 py-4 font-mono">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400 text-[10px]">#{stock.marketCapRank}</span>
                      <span className="font-bold text-sm text-slate-100">{stock.symbol}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <span className="font-medium text-slate-200 block">{stock.displayName}</span>
                    <span className="text-[11px] text-slate-400 block">{stock.sector}</span>
                  </td>
                  <td className="px-5 py-4 text-right font-mono font-semibold text-slate-200">
                    {formatINR(stock.referencePrice)}
                  </td>
                  <td className="px-5 py-4 text-right font-mono">
                    <span className={`font-bold ${isRsiPassing ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {stock.weeklyRsi.toFixed(1)}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-right font-mono text-slate-300">
                    {formatINR(stock.twentyWeekSma)}
                  </td>
                  <td className="px-5 py-4 text-center">
                    <Badge variant={stock.isEligible ? 'success' : 'danger'} size="sm" dot>
                      {stock.isEligible ? 'Eligible' : 'Ineligible'}
                    </Badge>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <Button
                      variant={stock.isEligible ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => handleOpenDemoEntry(stock)}
                      disabled={!stock.isEligible}
                    >
                      {stock.isEligible ? "Let's Dive In" : 'Ineligible'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Trade Entry Modal */}
      <TradeEntryModal
        stock={selectedStock}
        snapshot={selectedSnapshot}
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedStock(null);
          setSelectedSnapshot(null);
        }}
        onConfirmEntry={async (stockOrSnapshot, capital, customStopLossOrNotes, options) => {
          return await addInitialEntry(stockOrSnapshot, capital, customStopLossOrNotes, options);
        }}
      />
    </div>
  );
};
