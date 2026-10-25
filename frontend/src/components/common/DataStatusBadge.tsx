import { useState, useRef, useEffect, type FC } from 'react';
import { Info, ShieldAlert, ShieldCheck, Loader2 } from 'lucide-react';

export type DataStatusVariant = 'warning' | 'success' | 'info' | 'danger';

interface DataStatusBadgeProps {
  statusText?: string;
  asOfTimestamp?: string;
  sourceText?: string;
  variant?: DataStatusVariant;
}

export const DataStatusBadge: FC<DataStatusBadgeProps> = ({
  statusText = 'SAMPLE DATA',
  asOfTimestamp = '2026-10-23 15:30:00 IST',
  sourceText = 'Local Static Fixture (Non-Live)',
  variant = 'warning',
}) => {
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setShowPopover(false);
      }
    };

    if (showPopover) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showPopover]);

  const isSuccess = variant === 'success';
  const isDanger = variant === 'danger';
  const isInfo = variant === 'info';
  const isWarning = variant === 'warning';

  let buttonClass =
    'group inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wider transition-all cursor-pointer focus-visible:ring-2 outline-none ';
  let dotPingClass = 'bg-amber-400';
  let dotColor = 'bg-amber-500';
  let shouldPing = true;
  let iconClass = 'w-3.5 h-3.5 ';

  if (isSuccess) {
    buttonClass +=
      'bg-emerald-950/40 hover:bg-emerald-900/50 border border-emerald-600/40 text-emerald-300 focus-visible:ring-emerald-400';
    dotPingClass = 'bg-emerald-400';
    dotColor = 'bg-emerald-500';
    iconClass += 'text-emerald-400/80 group-hover:text-emerald-200';
  } else if (isDanger) {
    buttonClass +=
      'bg-rose-950/40 hover:bg-rose-900/50 border border-rose-600/40 text-rose-300 focus-visible:ring-rose-400';
    dotPingClass = 'bg-rose-400';
    dotColor = 'bg-rose-500';
    shouldPing = false;
    iconClass += 'text-rose-400/80 group-hover:text-rose-200';
  } else if (isInfo) {
    buttonClass +=
      'bg-slate-900/80 hover:bg-slate-800/80 border border-slate-700/60 text-slate-300 focus-visible:ring-cyan-400';
    dotPingClass = 'bg-cyan-400';
    dotColor = 'bg-cyan-500';
    iconClass += 'text-cyan-400/80 group-hover:text-cyan-200';
  } else {
    // isWarning
    buttonClass +=
      'bg-amber-950/40 hover:bg-amber-900/50 border border-amber-600/40 text-amber-300 focus-visible:ring-amber-400';
    dotPingClass = 'bg-amber-400';
    dotColor = 'bg-amber-500';
    iconClass += 'text-amber-400/80 group-hover:text-amber-200';
  }

  return (
    <div className="relative inline-block" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setShowPopover(!showPopover)}
        className={buttonClass}
        aria-expanded={showPopover}
        aria-haspopup="true"
        title="Click to view market data disclaimer & status"
      >
        <span className="relative flex h-2 w-2">
          {shouldPing && (
            <span
              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${dotPingClass}`}
            ></span>
          )}
          <span
            className={`relative inline-flex rounded-full h-2 w-2 ${dotColor}`}
          ></span>
        </span>
        <span className="font-mono">{statusText}</span>
        {isInfo ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400/80" />
        ) : (
          <Info className={iconClass} />
        )}
      </button>

      {showPopover && (
        <div
          className={`absolute right-0 mt-2 w-80 sm:w-96 p-4 rounded-xl bg-slate-900 border ${
            isSuccess
              ? 'border-emerald-500/30'
              : isDanger
              ? 'border-rose-500/30'
              : isInfo
              ? 'border-cyan-500/30'
              : 'border-amber-500/30'
          } shadow-2xl shadow-black z-50 text-left animate-in fade-in zoom-in-95 duration-150`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`p-2 rounded-lg border shrink-0 ${
                isSuccess
                  ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/50'
                  : isDanger
                  ? 'bg-rose-950/80 text-rose-400 border-rose-800/50'
                  : isInfo
                  ? 'bg-cyan-950/80 text-cyan-400 border-cyan-800/50'
                  : 'bg-amber-950/80 text-amber-400 border-amber-800/50'
              }`}
            >
              {isSuccess ? (
                <ShieldCheck className="w-5 h-5" />
              ) : isInfo ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <ShieldAlert className="w-5 h-5" />
              )}
            </div>
            <div>
              <h4 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                Market Data Status{' '}
                {isSuccess
                  ? '(Verified)'
                  : isDanger
                  ? '(Unavailable)'
                  : isWarning
                  ? statusText === 'STALE DATA'
                    ? '(Stale)'
                    : '(Demo Fixture)'
                  : '(Checking)'}
              </h4>
              <p
                className={`text-xs mt-1 font-medium ${
                  isSuccess
                    ? 'text-emerald-300/90'
                    : isDanger
                    ? 'text-rose-300/90'
                    : isInfo
                    ? 'text-cyan-300/90'
                    : 'text-amber-300/90'
                }`}
              >
                {isSuccess
                  ? 'Verified end-of-day market reference quotes and completed weekly indicators.'
                  : isDanger
                  ? 'Market data could not be verified by the backend. Trading decisions and entry creation are disabled.'
                  : isInfo
                  ? 'Establishing connection and verifying quotes with configured market data provider...'
                  : statusText === 'STALE DATA'
                  ? 'Market data quote timestamp is older than the latest completed trading session.'
                  : 'Non-live reference fixture for interface testing & decision support.'}
              </p>
            </div>
          </div>

          <div className="mt-3.5 pt-3 border-t border-slate-800 space-y-2 text-xs text-slate-300">
            <div className="flex justify-between">
              <span className="text-slate-400">Data Source:</span>
              <span className="font-medium text-slate-200">{sourceText}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">As-Of Timestamp:</span>
              <span className="font-mono text-cyan-300">{asOfTimestamp}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Candle Basis:</span>
              <span className="font-medium text-slate-200">Completed Weekly Close</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Broker Execution:</span>
              <span className="font-medium text-rose-400">Disabled (No Orders)</span>
            </div>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-slate-400 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
            <strong>Notice:</strong> NSE Trading Copilot does not connect to live broker order APIs. Reference prices and calculated position sizes are for personal paper tracking only.
          </p>
        </div>
      )}
    </div>
  );
};
