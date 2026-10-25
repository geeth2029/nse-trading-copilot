import { useState, useEffect, useRef, useCallback, type FC, type FormEvent } from 'react';
import { X, Lock, Mail, User, Loader2, AlertCircle, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: 'login' | 'register';
}

export const AuthModal: FC<AuthModalProps> = ({
  isOpen,
  onClose,
  initialMode = 'login',
}) => {
  const { login, register, authError, clearAuthError, isLoading: contextLoading } = useAuth();

  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [prevInitialMode, setPrevInitialMode] = useState(initialMode);
  if (initialMode !== prevInitialMode) {
    setPrevInitialMode(initialMode);
    setMode(initialMode);
    setClientError(null);
  }

  const emailInputRef = useRef<HTMLInputElement>(null);

  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    clearAuthError();
    setClientError(null);
    setEmail('');
    setPassword('');
    setDisplayName('');
    onClose();
  }, [isSubmitting, clearAuthError, onClose]);

  // Close modal on Escape key press
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, isSubmitting, handleClose]);

  // Autofocus first input when modal opens or mode switches
  useEffect(() => {
    if (isOpen) {
      emailInputRef.current?.focus();
    }
  }, [isOpen, mode]);

  if (!isOpen) return null;

  const handleModeChange = (newMode: 'login' | 'register') => {
    if (isSubmitting) return;
    setMode(newMode);
    setClientError(null);
    clearAuthError();
  };

  // Human-readable error mapper
  const formatErrorMessage = (errorText: string | null): string | null => {
    if (!errorText) return null;
    const lower = errorText.toLowerCase();

    if (lower.includes('registration is disabled')) {
      return 'New user registration is currently disabled by system administrators.';
    }
    if (lower.includes('unable to register with the supplied details') || lower.includes('conflict')) {
      return 'An account with this email address already exists or the details are invalid.';
    }
    if (lower.includes('invalid') || lower.includes('authentication required') || lower.includes('credentials')) {
      return 'Invalid email or password. Please verify your credentials and try again.';
    }
    if (lower.includes('network') || lower.includes('unable to connect') || lower.includes('fetch')) {
      return 'Network error: Unable to connect to the authentication service. Please check your connection.';
    }
    if (lower.includes('csrf')) {
      return 'Security verification (CSRF) failed. Please refresh the page and try again.';
    }

    return errorText;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (isSubmitting || contextLoading) return;

    setClientError(null);
    clearAuthError();

    // 1. Validate Email
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setClientError('Email address is required.');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      setClientError('Please enter a valid email address.');
      return;
    }

    // 2. Validate Password
    if (!password) {
      setClientError('Password is required.');
      return;
    }

    if (mode === 'register') {
      if (password.length < 12) {
        setClientError('Registration requires a secure password of at least 12 characters.');
        return;
      }
      if (displayName && displayName.trim().length > 120) {
        setClientError('Display name must not exceed 120 characters.');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      if (mode === 'login') {
        const result = await login(trimmedEmail, password);
        if (result.success) {
          // Clear sensitive state immediately
          setEmail('');
          setPassword('');
          setDisplayName('');
          onClose();
        }
      } else {
        const trimmedDisplayName = displayName.trim() ? displayName.trim() : null;
        const result = await register(trimmedEmail, password, trimmedDisplayName);
        if (result.success) {
          // Clear sensitive state immediately
          setEmail('');
          setPassword('');
          setDisplayName('');
          onClose();
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeError = clientError || formatErrorMessage(authError);
  const isRegistrationDisabled = authError?.toLowerCase().includes('registration is disabled');
  const isBusy = isSubmitting || contextLoading;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isBusy) {
          handleClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <div className="relative w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl shadow-cyan-950/20 overflow-hidden text-slate-100 animate-in zoom-in-95 duration-150">
        {/* Close Button */}
        <button
          type="button"
          onClick={handleClose}
          disabled={isBusy}
          className="absolute top-4 right-4 p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/80 transition-colors focus-visible:ring-2 focus-visible:ring-cyan-400 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Close dialog"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="p-6 pb-4 border-b border-slate-800/60 bg-slate-950/40">
          <div className="flex items-center gap-2 mb-1">
            <span className="p-1.5 rounded-lg bg-cyan-950/80 text-cyan-400 border border-cyan-800/60">
              <Lock className="w-4 h-4" />
            </span>
            <span className="text-[11px] font-mono tracking-wider text-cyan-400 uppercase font-semibold">
              NSE Trading Terminal
            </span>
          </div>
          <h2 id="auth-modal-title" className="text-xl font-bold tracking-tight text-slate-100">
            {mode === 'login' ? 'Sign In to Your Account' : 'Create Trader Account'}
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            {mode === 'login'
              ? 'Access verified session and server portfolio features'
              : 'Register for decision support and tracked paper positions'}
          </p>
        </div>

        {/* Tab Toggle */}
        <div className="flex border-b border-slate-800 bg-slate-950/60" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            aria-controls="auth-panel"
            onClick={() => handleModeChange('login')}
            disabled={isBusy}
            className={`flex-1 py-3 text-xs sm:text-sm font-medium tracking-wide transition-colors border-b-2 outline-none ${
              mode === 'login'
                ? 'border-cyan-400 text-cyan-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            aria-controls="auth-panel"
            onClick={() => handleModeChange('register')}
            disabled={isBusy}
            className={`flex-1 py-3 text-xs sm:text-sm font-medium tracking-wide transition-colors border-b-2 outline-none ${
              mode === 'register'
                ? 'border-cyan-400 text-cyan-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
            }`}
          >
            Register
          </button>
        </div>

        {/* Form Body */}
        <form
          id="auth-panel"
          onSubmit={handleSubmit}
          className="p-6 space-y-4"
          noValidate
        >
          {/* Active Error Banner */}
          {activeError && (
            <div
              role="alert"
              className={`flex items-start gap-3 p-3.5 rounded-lg border text-xs animate-in fade-in duration-150 ${
                isRegistrationDisabled
                  ? 'bg-amber-950/40 border-amber-800/60 text-amber-200'
                  : 'bg-rose-950/50 border-rose-800/60 text-rose-300'
              }`}
            >
              {isRegistrationDisabled ? (
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              )}
              <div className="flex-1 leading-relaxed">{activeError}</div>
            </div>
          )}

          {/* Email Field */}
          <div>
            <label
              htmlFor="auth-email-input"
              className="block text-xs font-semibold text-slate-300 mb-1.5"
            >
              Email Address <span className="text-cyan-400">*</span>
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Mail className="w-4 h-4" />
              </div>
              <input
                id="auth-email-input"
                ref={emailInputRef}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (clientError) setClientError(null);
                  if (authError) clearAuthError();
                }}
                disabled={isBusy}
                placeholder="trader@domain.com"
                required
                className="block w-full pl-9 pr-3.5 py-2.5 rounded-lg bg-slate-950/80 border border-slate-700/80 text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
          </div>

          {/* Display Name Field (Register Mode Only) */}
          {mode === 'register' && (
            <div className="animate-in fade-in duration-150">
              <label
                htmlFor="auth-display-name-input"
                className="block text-xs font-semibold text-slate-300 mb-1.5"
              >
                Display Name <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  id="auth-display-name-input"
                  type="text"
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    if (clientError) setClientError(null);
                  }}
                  disabled={isBusy}
                  maxLength={120}
                  placeholder="e.g. Lead Momentum Trader"
                  className="block w-full pl-9 pr-3.5 py-2.5 rounded-lg bg-slate-950/80 border border-slate-700/80 text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
            </div>
          )}

          {/* Password Field */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="auth-password-input"
                className="block text-xs font-semibold text-slate-300"
              >
                Password <span className="text-cyan-400">*</span>
              </label>
              {mode === 'register' && (
                <span
                  className={`text-[11px] font-mono flex items-center gap-1 ${
                    password.length >= 12 ? 'text-emerald-400' : 'text-slate-400'
                  }`}
                >
                  {password.length >= 12 && <CheckCircle2 className="w-3 h-3" />}
                  {password.length}/12 min chars
                </span>
              )}
            </div>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Lock className="w-4 h-4" />
              </div>
              <input
                id="auth-password-input"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (clientError) setClientError(null);
                  if (authError) clearAuthError();
                }}
                disabled={isBusy}
                placeholder={mode === 'register' ? 'At least 12 characters' : 'Enter your password'}
                required
                className="block w-full pl-9 pr-3.5 py-2.5 rounded-lg bg-slate-950/80 border border-slate-700/80 text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
          </div>

          {/* Submit Action */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={isBusy}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-semibold text-sm transition-all shadow-lg shadow-cyan-500/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400 outline-none"
            >
              {isBusy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
                  <span>{mode === 'login' ? 'Signing In...' : 'Creating Account...'}</span>
                </>
              ) : (
                <span>{mode === 'login' ? 'Sign In' : 'Register Account'}</span>
              )}
            </button>
          </div>

          {/* Footer mode switch hint */}
          <div className="text-center pt-2 text-xs text-slate-400">
            {mode === 'login' ? (
              <p>
                Don&apos;t have an account?{' '}
                <button
                  type="button"
                  onClick={() => handleModeChange('register')}
                  disabled={isBusy}
                  className="text-cyan-400 hover:text-cyan-300 font-medium underline underline-offset-2 outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 rounded disabled:opacity-50"
                >
                  Register here
                </button>
              </p>
            ) : (
              <p>
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => handleModeChange('login')}
                  disabled={isBusy}
                  className="text-cyan-400 hover:text-cyan-300 font-medium underline underline-offset-2 outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 rounded disabled:opacity-50"
                >
                  Sign in instead
                </button>
              </p>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
