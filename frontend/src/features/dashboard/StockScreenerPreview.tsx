import { useState, useMemo, type FC } from 'react';
import {
  Search,
  Filter,
  ArrowUpRight,
  TrendingUp,
} from 'lucide-react';
import type { ScreenerStock } from '../../types/trading';
import { Badge } from '../../components/common/Badge';
import { Button } from '../../components/common/Button';
import { formatINR } from '../../services/calculations';

interface StockScreenerPreviewProps {
  stocks: ScreenerStock[];
  onSelectStock: (stock: ScreenerStock) => void;
  onViewAll?: () => void;
  isDemo?: boolean;
}

export const StockScreenerPreview: FC<StockScreenerPreviewProps> = ({
  stocks,
  onSelectStock,
  onViewAll,
  isDemo = true,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'eligible' | 'ineligible'>('all');

  const filteredStocks = useMemo(() => {
    return stocks.filter((stock) => {
      const matchesSearch =
        stock.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
        stock.displayName.toLowerCase().includes(searchQuery.toLowerCase());

      if (!matchesSearch) return false;

      if (filterMode === 'eligible') return stock.isEligible;
      if (filterMode === 'ineligible') return !stock.isEligible;
      return true;
    });
  }, [stocks, searchQuery, filterMode]);

  const eligibleCount = stocks.filter((s) => s.isEligible).length;

  return (
    <div className="rounded-xl bg-slate-900/90 border border-slate-800 shadow-xl shadow-black/40 overflow-hidden">
      {/* Header and Controls */}
      <div className="p-5 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-cyan-400" />
              <span>NSE Screener Candidates</span>
            </h2>
            <Badge variant={isDemo ? 'warning' : 'success'} size="sm" dot={!isDemo}>
              {isDemo ? 'Sample Data' : 'Verified EOD Screener'}
            </Badge>
            <Badge variant="terminal" size="sm">
              Weekly RSI &gt; 60 Rule
            </Badge>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            AMFI large-cap universe evaluated against completed weekly candle criteria.
          </p>
        </div>

        {/* Filter Pills and Search */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Search Bar */}
          <div className="relative min-w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search symbol, company..."
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700/80 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
            />
          </div>

          {/* Quick Filter Tabs */}
          <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
            <button
              type="button"
              onClick={() => setFilterMode('all')}
              className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                filterMode === 'all'
                  ? 'bg-slate-800 text-slate-100 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All ({stocks.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('eligible')}
              className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                filterMode === 'eligible'
                  ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/80'
                  : 'text-slate-400 hover:text-emerald-400'
              }`}
            >
              Qualifying ({eligibleCount})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('ineligible')}
              className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                filterMode === 'ineligible'
                  ? 'bg-slate-800 text-slate-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Ineligible ({stocks.length - eligibleCount})
            </button>
          </div>

          {onViewAll && (
            <Button variant="outline" size="sm" onClick={onViewAll}>
              Full Screener
            </Button>
          )}
        </div>
      </div>

      {/* Accessible Table Wrapper (modern web guidance responsive-table) */}
      <div
        tabIndex={0}
        role="region"
        aria-label="NSE Stock Screener Candidates Table"
        className="overflow-x-auto focus-visible:ring-1 focus-visible:ring-cyan-400 outline-none"
      >
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-950/70 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              <th scope="col" className="px-5 py-3">
                Symbol &amp; Company
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Reference Price
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Weekly RSI (Strict &gt; 60)
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                20-Week SMA (Completed)
              </th>
              <th scope="col" className="px-5 py-3 text-center">
                Eligibility
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 text-xs">
            {filteredStocks.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-slate-400">
                  <div className="flex flex-col items-center justify-center space-y-2">
                    <Filter className="w-8 h-8 text-slate-400" />
                    <p className="text-sm font-medium text-slate-300">
                      No matching stocks found
                    </p>
                    <p className="text-xs text-slate-400">
                      Try adjusting your search query or switching filters.
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              filteredStocks.map((stock) => {
                const isRsiPassing = stock.weeklyRsi > 60.0;
                const rpsSpread = stock.referencePrice - stock.twentyWeekSma;

                return (
                  <tr
                    key={stock.symbol}
                    className="hover:bg-slate-800/40 transition-colors group"
                  >
                    {/* Symbol & Company */}
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            stock.isEligible
                              ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]'
                              : 'bg-slate-600'
                          }`}
                        />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold font-mono text-sm text-slate-100 group-hover:text-cyan-400 transition-colors">
                              {stock.symbol}
                            </span>
                            <span className="text-[10px] font-mono text-slate-400 px-1 rounded bg-slate-950 border border-slate-800">
                              {stock.exchange}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400 truncate max-w-[200px] sm:max-w-xs">
                            {stock.displayName}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Reference Price */}
                    <td className="px-5 py-3.5 text-right font-mono">
                      <div className="text-sm font-bold text-slate-100">
                        {formatINR(stock.referencePrice)}
                      </div>
                      <div
                        className={`text-[10px] font-medium ${
                          stock.dayChangePercent >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {stock.dayChangePercent >= 0 ? '+' : ''}
                        {stock.dayChangePercent.toFixed(2)}%
                      </div>
                    </td>

                    {/* Weekly RSI */}
                    <td className="px-5 py-3.5 text-right font-mono">
                      <div
                        className={`text-sm font-bold inline-flex items-center gap-1 ${
                          isRsiPassing ? 'text-emerald-400' : 'text-slate-400'
                        }`}
                      >
                        <span>{stock.weeklyRsi.toFixed(1)}</span>
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {isRsiPassing ? 'Momentum Confirmed' : 'Below 60 Filter'}
                      </div>
                    </td>

                    {/* 20-Week SMA */}
                    <td className="px-5 py-3.5 text-right font-mono">
                      <div className="text-sm font-semibold text-slate-200">
                        {formatINR(stock.twentyWeekSma)}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        Spread: {rpsSpread > 0 ? `+₹${rpsSpread.toFixed(1)}` : `₹${rpsSpread.toFixed(1)}`}
                      </div>
                    </td>

                    {/* Eligibility Badge */}
                    <td className="px-5 py-3.5 text-center">
                      {stock.isEligible ? (
                        <Badge variant="success" size="sm" dot>
                          Eligible
                        </Badge>
                      ) : (
                        <Badge variant="neutral" size="sm">
                          Not Eligible
                        </Badge>
                      )}
                    </td>

                    {/* Action: Clear "Let's Dive In" */}
                    <td className="px-5 py-3.5 text-right">
                      {stock.isEligible ? (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => onSelectStock(stock)}
                          icon={<ArrowUpRight className="w-3.5 h-3.5" />}
                          iconPosition="right"
                          className="shadow-sm"
                        >
                          Let's Dive In
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onSelectStock(stock)}
                          className="text-slate-400 hover:text-slate-200"
                        >
                          Inspect
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer helper */}
      <div className="px-5 py-3 border-t border-slate-800/80 bg-slate-950/50 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-400 gap-2">
        <span>
          Showing <strong>{filteredStocks.length}</strong> of <strong>{stocks.length}</strong> universe stocks • Latest completed weekly candle:{' '}
          <code className="text-cyan-300 text-[11px]">2026-10-16</code>
        </span>
        <span className={`text-[11px] font-mono ${isDemo ? 'text-amber-400/90' : 'text-emerald-400/90'}`}>
          {isDemo ? '* Reference Quotes (Sample Data)' : '* Verified TejHQ EOD Market Data'}
        </span>
      </div>
    </div>
  );
};
