import { type FC, type ReactNode } from 'react';

interface SummaryCardProps {
  title: string;
  value: string | number;
  subValue?: string;
  icon: ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  accentColor?: 'cyan' | 'emerald' | 'amber' | 'indigo' | 'rose';
  footnote?: string;
  onClick?: () => void;
}

export const SummaryCard: FC<SummaryCardProps> = ({
  title,
  value,
  subValue,
  icon,
  trend = 'neutral',
  accentColor = 'cyan',
  footnote,
  onClick,
}) => {
  const accentGradients = {
    cyan: 'from-cyan-500/10 via-cyan-500/5 to-transparent border-cyan-500/20 text-cyan-400',
    emerald: 'from-emerald-500/10 via-emerald-500/5 to-transparent border-emerald-500/20 text-emerald-400',
    amber: 'from-amber-500/10 via-amber-500/5 to-transparent border-amber-500/20 text-amber-400',
    indigo: 'from-indigo-500/10 via-indigo-500/5 to-transparent border-indigo-500/20 text-indigo-400',
    rose: 'from-rose-500/10 via-rose-500/5 to-transparent border-rose-500/20 text-rose-400',
  };

  const iconBgStyles = {
    cyan: 'bg-cyan-950/80 text-cyan-400 border-cyan-800/60',
    emerald: 'bg-emerald-950/80 text-emerald-400 border-emerald-800/60',
    amber: 'bg-amber-950/80 text-amber-400 border-amber-800/60',
    indigo: 'bg-indigo-950/80 text-indigo-400 border-indigo-800/60',
    rose: 'bg-rose-950/80 text-rose-400 border-rose-800/60',
  };

  return (
    <div
      onClick={onClick}
      className={`rounded-xl bg-gradient-to-b ${accentGradients[accentColor]} bg-slate-900/90 border p-5 shadow-lg shadow-black/40 relative overflow-hidden transition-all duration-200 hover:border-slate-700/80 ${
        onClick ? 'cursor-pointer hover:scale-[1.01]' : ''
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-xs font-medium text-slate-400 tracking-wide uppercase">
            {title}
          </p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-extrabold tracking-tight font-mono text-slate-100">
              {value}
            </span>
          </div>
          {subValue && (
            <p
              className={`text-xs font-medium flex items-center gap-1 ${
                trend === 'up'
                  ? 'text-emerald-400'
                  : trend === 'down'
                  ? 'text-rose-400'
                  : 'text-slate-400'
              }`}
            >
              {subValue}
            </p>
          )}
        </div>

        <div className={`p-3 rounded-xl border ${iconBgStyles[accentColor]} shrink-0`}>
          {icon}
        </div>
      </div>

      {footnote && (
        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
          <span>{footnote}</span>
        </div>
      )}
    </div>
  );
};
