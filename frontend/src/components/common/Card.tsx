import { type FC, type ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
  bodyClassName?: string;
  glow?: boolean;
}

export const Card: FC<CardProps> = ({
  children,
  title,
  subtitle,
  action,
  icon,
  className = '',
  bodyClassName = '',
  glow = false,
}) => {
  return (
    <div
      className={`rounded-xl bg-slate-900/90 border border-slate-800/80 shadow-lg shadow-black/40 backdrop-blur-sm transition-all duration-200 ${
        glow ? 'border-cyan-500/30 shadow-cyan-950/20' : 'hover:border-slate-700/80'
      } ${className}`}
    >
      {(title || action || icon) && (
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800/80">
          <div className="flex items-center gap-3">
            {icon && (
              <div className="p-2 rounded-lg bg-slate-800/80 text-cyan-400 border border-slate-700/50">
                {icon}
              </div>
            )}
            <div>
              {title && (
                <h3 className="text-sm font-semibold text-slate-100 tracking-tight">
                  {title}
                </h3>
              )}
              {subtitle && (
                <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>
              )}
            </div>
          </div>
          {action && <div className="flex items-center gap-2">{action}</div>}
        </div>
      )}
      <div className={`p-5 ${bodyClassName}`}>{children}</div>
    </div>
  );
};
