import { type FC } from 'react';
import {
  History,
  TrendingUp,
  LogOut,
  Layers,
  ArrowRight,
} from 'lucide-react';
import type { TradeActivityItem } from '../../types/trading';
import { Badge } from '../../components/common/Badge';
import { formatINR, formatShares } from '../../services/calculations';

interface RecentActivitySectionProps {
  activities: TradeActivityItem[];
  onViewAll?: () => void;
}

export const RecentActivitySection: FC<RecentActivitySectionProps> = ({
  activities,
  onViewAll,
}) => {
  const getActivityIcon = (type: TradeActivityItem['type']) => {
    switch (type) {
      case 'INITIAL_ENTRY':
        return <TrendingUp className="w-4 h-4 text-cyan-400" />;
      case 'PYRAMID_ENTRY':
        return <Layers className="w-4 h-4 text-indigo-400" />;
      case 'POSITION_EXIT':
        return <LogOut className="w-4 h-4 text-emerald-400" />;
    }
  };

  const getActivityBadge = (type: TradeActivityItem['type']) => {
    switch (type) {
      case 'INITIAL_ENTRY':
        return (
          <Badge variant="info" size="sm">
            Initial Entry
          </Badge>
        );
      case 'PYRAMID_ENTRY':
        return (
          <Badge variant="terminal" size="sm">
            Pyramid (+1)
          </Badge>
        );
      case 'POSITION_EXIT':
        return (
          <Badge variant="success" size="sm">
            Position Closed
          </Badge>
        );
    }
  };

  return (
    <div className="rounded-xl bg-slate-900/90 border border-slate-800 shadow-xl shadow-black/40 overflow-hidden">
      {/* Header */}
      <div className="p-5 border-b border-slate-800 flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <History className="w-4 h-4 text-cyan-400" />
            <span>Recent Portfolio Activity</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Snapshot history of recorded paper entries, pyramids, and single accumulated exits.
          </p>
        </div>

        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="text-xs text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1 transition-colors"
          >
            <span>View All History</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Activity List */}
      <div className="divide-y divide-slate-800/60">
        {activities.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-xs">
            No recent activity recorded.
          </div>
        ) : (
          activities.map((activity) => {
            const isExit = activity.type === 'POSITION_EXIT';
            const isWarning = activity.status === 'INVALID_RPS_WARNING';

            return (
              <div
                key={activity.id}
                className="p-4 sm:px-5 hover:bg-slate-800/30 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                {/* Left: Icon, Symbol, Type, Date */}
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 mt-0.5">
                    {getActivityIcon(activity.type)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold font-mono text-sm text-slate-100">
                        {activity.symbol}
                      </span>
                      {getActivityBadge(activity.type)}
                      {isWarning && (
                        <Badge variant="warning" size="sm">
                          Warning Sizing
                        </Badge>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {activity.companyName} • <span className="font-mono text-slate-400">{activity.date}</span>
                    </div>
                    {activity.notes && (
                      <p className="text-[11px] text-slate-400 mt-1 italic max-w-xl">
                        {activity.notes}
                      </p>
                    )}
                  </div>
                </div>

                {/* Right: Quantity, Price, P&L */}
                <div className="flex sm:flex-col items-end justify-between sm:justify-center border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-800/80 font-mono text-right">
                  {isExit ? (
                    <>
                      <div className="text-emerald-400 font-bold text-sm">
                        {formatINR(activity.pnl)}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Exit Price: {formatINR(activity.price)} • {formatShares(activity.quantity)} shs
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-slate-100 font-semibold text-sm">
                        {activity.quantity !== null
                          ? `${formatShares(activity.quantity)} shares`
                          : 'Null Quantity'}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Ref Entry: {formatINR(activity.price)}
                        {activity.stopLoss && ` • SL: ${formatINR(activity.stopLoss)}`}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-2.5 bg-slate-950/40 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
        <span>History records are immutable once saved per architecture rules.</span>
        <span className="font-mono text-slate-400">Zero broker fill claims</span>
      </div>
    </div>
  );
};
