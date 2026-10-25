import { useState, useEffect, type FC } from 'react';
import {
  Menu,
  User,
  Clock,
  Activity,
  LogIn,
  LogOut,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { DataStatusBadge, type DataStatusVariant } from '../common/DataStatusBadge';
import { useAuth } from '../../context/AuthContext';
import { useOptionalPortfolio } from '../../context/PortfolioContext';
import { AuthModal } from '../auth/AuthModal';
import { fetchLargeCapUniverseStatus, fetchMarketSnapshot } from '../../services/api';

export type MarketDataStatusType =
  | 'loading'
  | 'verified'
  | 'stale'
  | 'unavailable'
  | 'error'
  | 'demo';

export interface TopBarProps {
  pageTitle: string;
  pageSubtitle?: string;
  onToggleMobileMenu?: () => void;
  dataStatus?: string;
  asOfTimestamp?: string;
  marketDataStatus?: MarketDataStatusType;
  providerName?: string;
  sourceText?: string;
}

// eslint-disable-next-line react-refresh/only-export-components
// oxlint-disable-next-line react/only-export-components
export function formatProviderName(source?: string | null): string {
  if (!source) return 'Configured Market Provider';
  const upper = source.trim().toUpperCase();
  if (upper === 'TEJHQ' || upper === 'TEJ') return 'TejHQ EOD Market Data (NSE)';
  if (upper === 'UPSTOX') return 'Upstox API (NSE Cash)';
  return `${source} Market Data (NSE)`;
}

export const TopBar: FC<TopBarProps> = ({
  pageTitle,
  pageSubtitle,
  onToggleMobileMenu,
  dataStatus = 'SAMPLE DATA',
  asOfTimestamp = '2026-10-23 15:30:00 IST',
  marketDataStatus,
  providerName,
  sourceText: explicitSourceText,
}) => {
  const { user, isAuthenticated, isLoading, authError, logout, checkSession } = useAuth();
  const portfolioContext = useOptionalPortfolio();
  const portfolioMode = portfolioContext?.portfolioMode ?? 'demo';
  const setPortfolioMode = portfolioContext?.setPortfolioMode;
  const isAuthMode = isAuthenticated && portfolioMode === 'authenticated';

  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isRetryingSession, setIsRetryingSession] = useState(false);

  // Asynchronous market data verification state for authenticated mode
  const [dataVerificationStatus, setDataVerificationStatus] = useState<
    'loading' | 'verified' | 'stale' | 'unavailable' | 'error'
  >('loading');
  const [detectedProvider, setDetectedProvider] = useState<string | null>(null);
  const [detectedAsOf, setDetectedAsOf] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthMode || marketDataStatus) {
      return;
    }

    let isMounted = true;

    async function checkMarketData() {
      try {
        // 1. Verify large-cap universe status
        const uStatus = await fetchLargeCapUniverseStatus();
        if (!isMounted) return;

        if (uStatus.status !== 'VALID') {
          setDataVerificationStatus('unavailable');
          setDetectedProvider(uStatus.datasetVersion || 'AMFI Universe');
          return;
        }

        // 2. Query market data snapshot from the configured provider
        const snapshot = await fetchMarketSnapshot('RELIANCE');
        if (!isMounted) return;

        const providerLabel = formatProviderName(snapshot.source);
        setDetectedProvider(providerLabel);
        if (snapshot.quoteTimestamp) {
          setDetectedAsOf(snapshot.quoteTimestamp);
        }

        if (snapshot.isStale) {
          setDataVerificationStatus('stale');
        } else {
          setDataVerificationStatus('verified');
        }
      } catch {
        if (!isMounted) return;
        setDataVerificationStatus('error');
      }
    }

    void checkMarketData();

    return () => {
      isMounted = false;
    };
  }, [isAuthMode, marketDataStatus]);

  const isVerificationFailed = !isAuthenticated && !isLoading && authError !== null;

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      const result = await logout();
      if (!result.success && result.error) {
        setLogoutError(result.error);
      }
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleRetrySession = async () => {
    setIsRetryingSession(true);
    try {
      await checkSession();
    } finally {
      setIsRetryingSession(false);
    }
  };

  const userDisplayName = user?.displayName || user?.email || 'Paper Trader';

  return (
    <>
      <header className="sticky top-0 z-30 w-full bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-4 sm:px-6 py-3.5">
        <div className="flex items-center justify-between gap-4">
          {/* Left: Mobile hamburger & Page Title */}
          <div className="flex items-center gap-3">
            {onToggleMobileMenu && (
              <button
                type="button"
                onClick={onToggleMobileMenu}
                className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/80 lg:hidden focus-visible:ring-2 focus-visible:ring-cyan-400 outline-none"
                aria-label="Open navigation menu"
              >
                <Menu className="w-5 h-5" />
              </button>
            )}

            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg sm:text-xl font-bold tracking-tight text-slate-100">
                  {pageTitle}
                </h1>
                <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-950/60 text-emerald-400 border border-emerald-800/60">
                  <Activity className="w-3 h-3 text-emerald-400" />
                  NSE Cash Market
                </span>
              </div>
              {pageSubtitle && (
                <p className="text-xs text-slate-400 hidden sm:block mt-0.5">
                  {pageSubtitle}
                </p>
              )}
            </div>
          </div>

          {/* Right: Demo indicator, Session retry, Data Status, Auth controls */}
          <div className="flex items-center gap-2.5 sm:gap-3.5">
            {/* Mode Indicator / Switcher */}
            {isAuthenticated && setPortfolioMode ? (
              portfolioMode === 'authenticated' ? (
                <button
                  type="button"
                  onClick={() => setPortfolioMode('demo')}
                  className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20 cursor-pointer transition-colors"
                  title="Currently viewing your authenticated server-side portfolio. Click to switch to Demo Mode."
                  aria-label="Switch to Demo Mode"
                >
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span>Live Portfolio</span>
                  <span className="text-[10px] text-emerald-400/80 underline font-sans ml-1">Switch to Demo</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setPortfolioMode('authenticated')}
                  className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono font-medium bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 cursor-pointer transition-colors"
                  title="Currently viewing demo simulation mode. Click to switch to your authenticated portfolio."
                  aria-label="Switch to Authenticated Portfolio Mode"
                >
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                  </span>
                  <span>Demo Mode (Mock Data)</span>
                  <span className="text-[10px] text-amber-400/80 underline font-sans ml-1">Switch to Live</span>
                </button>
              )
            ) : (
              <div
                className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono font-medium bg-amber-500/10 text-amber-300 border border-amber-500/30"
                title="Portfolio is currently operating in demo simulation mode with mock fixtures"
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                </span>
                <span>Demo Mode (Mock Data)</span>
              </div>
            )}


            {/* As-Of Session Date */}
            <div className="hidden md:flex items-center gap-1.5 text-xs text-slate-400 font-mono bg-slate-900/80 px-3 py-1.5 rounded-lg border border-slate-800">
              <Clock className="w-3.5 h-3.5 text-cyan-400" />
              <span>Ref As-Of: 23-Oct Close</span>
            </div>

            {/* Prominent Data Status Badge */}
            {(() => {
              const effectiveStatus: MarketDataStatusType =
                marketDataStatus ?? (!isAuthMode ? 'demo' : dataVerificationStatus);

              let resolvedStatusText = dataStatus;
              let resolvedVariant: DataStatusVariant = 'warning';
              let resolvedSourceText = explicitSourceText || 'Static Demo Fixture (Non-Live)';
              let resolvedAsOf = asOfTimestamp;

              if (effectiveStatus === 'demo') {
                resolvedStatusText = dataStatus || 'SAMPLE DATA';
                resolvedVariant = 'warning';
                resolvedSourceText = explicitSourceText || 'Static Demo Fixture (Non-Live)';
                resolvedAsOf = asOfTimestamp || '2026-10-23 15:30:00 IST';
              } else if (effectiveStatus === 'loading') {
                resolvedStatusText = 'CHECKING DATA...';
                resolvedVariant = 'info';
                resolvedSourceText = explicitSourceText || 'Establishing market data status...';
                resolvedAsOf = 'Verifying...';
              } else if (effectiveStatus === 'verified') {
                resolvedStatusText = 'VERIFIED EOD';
                resolvedVariant = 'success';
                resolvedSourceText =
                  explicitSourceText ||
                  (providerName
                    ? formatProviderName(providerName)
                    : detectedProvider || 'TejHQ EOD Market Data (NSE)');
                resolvedAsOf = asOfTimestamp || detectedAsOf || '2026-10-23 15:30:00 IST';
              } else if (effectiveStatus === 'stale') {
                resolvedStatusText = 'STALE DATA';
                resolvedVariant = 'warning';
                resolvedSourceText =
                  explicitSourceText ||
                  (providerName
                    ? `${formatProviderName(providerName)} (Stale)`
                    : `${detectedProvider || 'Market Provider'} (Stale)`);
                resolvedAsOf = asOfTimestamp || detectedAsOf || 'Quote date is stale';
              } else if (effectiveStatus === 'unavailable') {
                resolvedStatusText = 'DATA UNAVAILABLE';
                resolvedVariant = 'danger';
                resolvedSourceText =
                  explicitSourceText ||
                  (detectedProvider
                    ? `${detectedProvider} (Unavailable)`
                    : 'Large-Cap Market Data Unavailable');
                resolvedAsOf = 'Unavailable';
              } else if (effectiveStatus === 'error') {
                resolvedStatusText = 'PROVIDER ERROR';
                resolvedVariant = 'danger';
                resolvedSourceText = explicitSourceText || 'Market Data Provider Error';
                resolvedAsOf = 'Provider Error';
              }

              return (
                <DataStatusBadge
                  statusText={resolvedStatusText}
                  asOfTimestamp={resolvedAsOf}
                  sourceText={resolvedSourceText}
                  variant={resolvedVariant}
                />
              );
            })()}

            {/* Session Verification Failed Warning & Retry */}
            {isVerificationFailed && (
              <div
                role="status"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-950/40 border border-rose-800/60 text-rose-300 text-xs"
                title={authError || 'Session verification failed'}
              >
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                <span className="hidden sm:inline">Session check failed</span>
                <button
                  type="button"
                  onClick={handleRetrySession}
                  disabled={isRetryingSession || isLoading}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-cyan-400 hover:text-cyan-300 underline underline-offset-2 ml-1 cursor-pointer disabled:opacity-50"
                  aria-label="Retry session verification"
                >
                  <RefreshCw
                    className={`w-3 h-3 ${isRetryingSession ? 'animate-spin' : ''}`}
                  />
                  <span>Retry</span>
                </button>
              </div>
            )}

            {/* Authentication Section */}
            <div className="flex items-center gap-2 pl-2 sm:pl-3 border-l border-slate-800">
              {isLoading && !user ? (
                <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 font-mono">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                  <span className="hidden sm:inline">Verifying...</span>
                </div>
              ) : isAuthenticated && user ? (
                /* Authenticated User Profile & Sign Out */
                <div className="flex items-center gap-2.5">
                  <div
                    className="flex items-center gap-2.5"
                    title={`Logged in as ${user.email}`}
                  >
                    <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-600 to-indigo-600 flex items-center justify-center text-slate-950 font-bold text-xs ring-2 ring-cyan-500/40">
                      {user.displayName ? (
                        user.displayName.charAt(0).toUpperCase()
                      ) : (
                        <User className="w-4 h-4 text-slate-950" />
                      )}
                    </div>
                    <div className="hidden xl:block text-left">
                      <div className="text-xs font-semibold text-slate-200 leading-tight truncate max-w-[140px]">
                        {userDisplayName}
                      </div>
                      <div className="text-[10px] text-cyan-400 font-mono truncate max-w-[140px]">
                        {user.displayName ? user.email : 'Verified Session'}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleLogout}
                    disabled={isLoggingOut}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/80 text-xs transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400 outline-none disabled:opacity-50"
                    aria-label="Sign out of your account"
                  >
                    {isLoggingOut ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                    ) : (
                      <LogOut className="w-3.5 h-3.5" />
                    )}
                    <span className="hidden sm:inline">Sign Out</span>
                  </button>

                  {logoutError && (
                    <span
                      role="alert"
                      className="text-[10px] text-rose-400 font-mono"
                      title={logoutError}
                    >
                      Logout failed
                    </span>
                  )}
                </div>
              ) : (
                /* Unauthenticated Sign In Action */
                <button
                  type="button"
                  onClick={() => setIsAuthModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 sm:px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-semibold text-xs tracking-wide transition-all shadow-md shadow-cyan-500/20 cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400 outline-none"
                  aria-label="Sign in to your account"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>Sign In</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Authentication Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />
    </>
  );
};
