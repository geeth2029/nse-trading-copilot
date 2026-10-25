import { useState, type FC, type ReactNode } from 'react';
import { Sidebar, type NavTabId } from './Sidebar';
import { TopBar } from './TopBar';

interface MainLayoutProps {
  children: ReactNode;
  activeTab: NavTabId;
  onTabChange: (tab: NavTabId) => void;
  pageTitle: string;
  pageSubtitle?: string;
}

export const MainLayout: FC<MainLayoutProps> = ({
  children,
  activeTab,
  onTabChange,
  pageTitle,
  pageSubtitle,
}) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#0B0E14] text-slate-100 flex flex-col lg:flex-row antialiased selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Sidebar Navigation */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={onTabChange}
        isOpenMobile={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
      />

      {/* Main Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          pageTitle={pageTitle}
          pageSubtitle={pageSubtitle}
          onToggleMobileMenu={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
          {children}
        </main>

        {/* Global Footer Disclaimer */}
        <footer className="border-t border-slate-900 bg-slate-950/40 px-6 py-4 text-center text-xs text-slate-400">
          <p>
            <strong>NSE Trading Copilot</strong> • Milestone 1 (Frontend Architecture & Dashboard). All displayed market quotes are sample reference fixtures for decision support and paper simulation. No broker order execution.
          </p>
        </footer>
      </div>
    </div>
  );
};
