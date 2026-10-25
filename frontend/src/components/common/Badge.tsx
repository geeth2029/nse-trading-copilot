import { type FC, type ReactNode } from 'react';

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'terminal';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  dot?: boolean;
  className?: string;
}

export const Badge: FC<BadgeProps> = ({
  children,
  variant = 'neutral',
  size = 'md',
  dot = false,
  className = '',
}) => {
  const variantStyles: Record<BadgeVariant, { container: string; dot: string }> = {
    success: {
      container: 'bg-emerald-950/70 text-emerald-400 border border-emerald-800/80',
      dot: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]',
    },
    warning: {
      container: 'bg-amber-950/70 text-amber-300 border border-amber-800/80',
      dot: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]',
    },
    danger: {
      container: 'bg-rose-950/70 text-rose-400 border border-rose-800/80',
      dot: 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.6)]',
    },
    info: {
      container: 'bg-sky-950/70 text-sky-400 border border-sky-800/80',
      dot: 'bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.6)]',
    },
    neutral: {
      container: 'bg-slate-900 text-slate-300 border border-slate-700/80',
      dot: 'bg-slate-400',
    },
    terminal: {
      container: 'bg-cyan-950/60 text-cyan-300 border border-cyan-800/60 font-mono',
      dot: 'bg-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.7)]',
    },
  };

  const sizeStyles = {
    sm: 'text-xs px-2 py-0.5 gap-1.5',
    md: 'text-xs px-2.5 py-1 gap-1.5 font-medium',
  };

  const selected = variantStyles[variant];

  return (
    <span
      className={`inline-flex items-center rounded-full tracking-wide transition-colors ${selected.container} ${sizeStyles[size]} ${className}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${selected.dot}`} />}
      {children}
    </span>
  );
};
