import { useState } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import type { NavTabId } from './components/layout/Sidebar';
import { AuthProvider } from './context/AuthContext';
import { PortfolioProvider } from './context/PortfolioContext';
import { DashboardView } from './features/dashboard/DashboardView';
import { ScreenerView } from './features/screener/ScreenerView';
import { PortfolioView } from './features/portfolio/PortfolioView';
import { ArchivedView } from './features/archived/ArchivedView';
import { SettingsView } from './features/settings/SettingsView';

export function App() {
  const [activeTab, setActiveTab] = useState<NavTabId>('dashboard');

  const getPageInfo = (): { title: string; subtitle?: string } => {
    switch (activeTab) {
      case 'dashboard':
        return {
          title: 'Trading Terminal Dashboard',
          subtitle: 'NSE Cash Equity Decision Support & Capital Sizing',
        };
      case 'screener':
        return {
          title: 'NSE Stock Screener',
          subtitle: 'AMFI Large-Cap Universe Momentum & Trend Filters',
        };
      case 'portfolio':
        return {
          title: 'Tracked Portfolio',
          subtitle: 'Individual Multi-Entry Positions & Pyramiding Tracker',
        };
      case 'archived':
        return {
          title: 'Archived Positions',
          subtitle: 'Permanent Audit History of Closed Paper Positions',
        };
      case 'settings':
        return {
          title: 'Settings & Risk Parameters',
          subtitle: 'Configuration & Core Trading Boundaries',
        };
    }
  };

  const { title, subtitle } = getPageInfo();

  return (
    <AuthProvider>
      <PortfolioProvider>
        <MainLayout
          activeTab={activeTab}
          onTabChange={setActiveTab}
          pageTitle={title}
          pageSubtitle={subtitle}
        >
          {activeTab === 'dashboard' && (
            <DashboardView
              onNavigateToScreener={() => setActiveTab('screener')}
              onNavigateToPortfolio={() => setActiveTab('portfolio')}
              onNavigateToArchived={() => setActiveTab('archived')}
            />
          )}

          {activeTab === 'screener' && <ScreenerView />}

          {activeTab === 'portfolio' && <PortfolioView />}

          {activeTab === 'archived' && <ArchivedView />}

          {activeTab === 'settings' && <SettingsView />}
        </MainLayout>
      </PortfolioProvider>
    </AuthProvider>
  );
}

export default App;
