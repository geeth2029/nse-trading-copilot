import { type FC, type ReactNode } from 'react';
import {
  LayoutDashboard,
  Filter,
  Briefcase,
  Archive,
  Settings,
  TrendingUp,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';
import { usePortfolio } from '../../context/PortfolioContext';

export type NavTabId = 'dashboard' | 'screener' | 'portfolio' | 'archived' | 'settings';

interface SidebarProps {
  activeTab: NavTabId;
  onTabChange: (tab: NavTabId) => void;
  isOpenMobile?: boolean;
  onCloseMobile?: () => void;
  qualifiedCount?: number | null;
}

interface NavItemConfig {
  id: NavTabId;
  label: string;
  icon: ReactNode;
  badge?: string;
  isPlaceholder?: boolean;
}

export const Sidebar: FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  isOpenMobile = false,
  onCloseMobile,
  qualifiedCount,
}) => {
  const { activePositions, archivedPositions, screenerQualifiedCount: contextCount } = usePortfolio();
  const screenerQualifiedCount = qualifiedCount !== undefined ? qualifiedCount : contextCount;

  const navItems: NavItemConfig[] = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      icon: <LayoutDashboard className="w-5 h-5" />,
    },
    {
      id: 'screener',
      label: 'Stock Screener',
      icon: <Filter className="w-5 h-5" />,
      badge: screenerQualifiedCount !== null ? `${screenerQualifiedCount} Qualified` : undefined,
    },
    {
      id: 'portfolio',
      label: 'My Portfolio',
      icon: <Briefcase className="w-5 h-5" />,
      badge: `${activePositions.length} Active`,
    },
    {
      id: 'archived',
      label: 'Archived Positions',
      icon: <Archive className="w-5 h-5" />,
      badge: `${archivedPositions.length} Preserved`,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: <Settings className="w-5 h-5" />,
    },
  ];

  const handleSelect = (id: NavTabId) => {
    onTabChange(id);
    if (onCloseMobile) onCloseMobile();
  };

  return (
    <>
      {/* Mobile overlay */}
      {isOpenMobile && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed lg:static top-0 bottom-0 left-0 z-40 w-64 bg-slate-950 border-r border-slate-800/80 flex flex-col justify-between transition-transform duration-200 ease-in-out ${
          isOpenMobile ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Top: Logo & App Branding */}
        <div>
          <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-800/80">
            <div className="p-2.5 rounded-xl bg-gradient-to-tr from-cyan-600 to-indigo-600 text-slate-950 shadow-md shadow-cyan-900/30">
              <TrendingUp className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-extrabold text-base tracking-tight text-slate-100">
                  NSE Copilot
                </span>
                <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/60">
                  v0.1
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-medium tracking-wide">
                Trading Decision Support
              </p>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="p-4 space-y-1.5" aria-label="Main Navigation">
            <div className="px-3 py-2 text-[11px] font-semibold tracking-wider uppercase text-slate-400">
              Platform
            </div>
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item.id)}
                  type="button"
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-all group outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                    isActive
                      ? 'bg-slate-900 text-cyan-400 shadow-sm border border-slate-700/80'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`transition-colors ${
                        isActive
                          ? 'text-cyan-400'
                          : 'text-slate-400 group-hover:text-slate-200'
                      }`}
                    >
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {item.badge && (
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                          isActive
                            ? 'bg-cyan-950 text-cyan-300 border border-cyan-800'
                            : 'bg-slate-900 text-slate-400 border border-slate-800'
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                    {isActive && (
                      <ChevronRight className="w-4 h-4 text-cyan-400 hidden sm:block" />
                    )}
                  </div>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom: Trading Discipline & Architecture Badge */}
        <div className="p-4 border-t border-slate-800/80">
          <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 text-xs">
            <div className="flex items-center gap-2 text-cyan-400 font-semibold mb-1">
              <ShieldCheck className="w-4 h-4" />
              <span>Rule Enforcement</span>
            </div>
            <ul className="text-[11px] text-slate-400 space-y-1">
              <li>• Weekly RSI strictly &gt; 60</li>
              <li>• 1% Capital Risk Per Trade</li>
              <li>• 20-Week Completed SMA</li>
              <li>• Zero live broker orders</li>
            </ul>
          </div>
        </div>
      </aside>
    </>
  );
};
