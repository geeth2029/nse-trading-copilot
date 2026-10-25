import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type FC,
  type ReactNode,
} from 'react';
import {
  fetchCurrentUser,
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  AuthenticationError,
  NetworkError,
  type UserRead,
} from '../services/api';

export interface AuthContextType {
  user: UserRead | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authError: string | null;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (
    email: string,
    password: string,
    displayName?: string | null
  ) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<{ success: boolean; error?: string }>;
  clearAuthError: () => void;
  checkSession: () => Promise<void>;
}

// eslint-disable-next-line react/only-export-components
// oxlint-disable-next-line react/only-export-components
export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserRead | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const isMountedRef = useRef<boolean>(true);

  const checkSession = useCallback(async () => {
    setIsLoading(true);
    try {
      const currentUser = await fetchCurrentUser();
      if (!isMountedRef.current) return;
      setUser(currentUser);
      setIsAuthenticated(true);
      setAuthError(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      if (err instanceof AuthenticationError) {
        // Normal unauthenticated session; not an application error
        setUser(null);
        setIsAuthenticated(false);
        setAuthError(null);
      } else {
        // Network failure or unexpected service error: preserve distinction from unauthenticated
        setUser(null);
        setIsAuthenticated(false);
        const message =
          err instanceof NetworkError
            ? 'Session verification failed: Unable to connect to the authentication service.'
            : err instanceof Error
              ? err.message
              : 'Session verification failed.';
        setAuthError(message);
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;

    async function initialVerify() {
      try {
        const currentUser = await fetchCurrentUser();
        if (cancelled || !isMountedRef.current) return;
        setUser(currentUser);
        setIsAuthenticated(true);
        setAuthError(null);
      } catch (err) {
        if (cancelled || !isMountedRef.current) return;
        if (err instanceof AuthenticationError) {
          setUser(null);
          setIsAuthenticated(false);
          setAuthError(null);
        } else {
          setUser(null);
          setIsAuthenticated(false);
          const message =
            err instanceof NetworkError
              ? 'Session verification failed: Unable to connect to the authentication service.'
              : err instanceof Error
                ? err.message
                : 'Session verification failed.';
          setAuthError(message);
        }
      } finally {
        if (!cancelled && isMountedRef.current) {
          setIsLoading(false);
        }
      }
    }

    initialVerify();

    return () => {
      cancelled = true;
      isMountedRef.current = false;
    };
  }, []);

  const login = async (
    email: string,
    password: string
  ): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);
    setAuthError(null);
    try {
      const loggedInUser = await apiLogin(email, password);
      if (isMountedRef.current) {
        setUser(loggedInUser);
        setIsAuthenticated(true);
        setAuthError(null);
      }
      return { success: true };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Login failed. Please check your credentials.';
      if (isMountedRef.current) {
        setAuthError(message);
      }
      return { success: false, error: message };
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  };

  const register = async (
    email: string,
    password: string,
    displayName?: string | null
  ): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);
    setAuthError(null);
    try {
      const registeredUser = await apiRegister(email, password, displayName);
      if (isMountedRef.current) {
        setUser(registeredUser);
        setIsAuthenticated(true);
        setAuthError(null);
      }
      return { success: true };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Registration failed. Please try again.';
      if (isMountedRef.current) {
        setAuthError(message);
      }
      return { success: false, error: message };
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  };

  const logout = async (): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);
    try {
      await apiLogout();
      if (isMountedRef.current) {
        setUser(null);
        setIsAuthenticated(false);
        setAuthError(null);
      }
      return { success: true };
    } catch (err) {
      // Do not falsely report that logout succeeded when the server call failed.
      const message =
        err instanceof Error ? err.message : 'Logout failed. Session may still be active.';
      if (isMountedRef.current) {
        setAuthError(message);
      }
      return { success: false, error: message };
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  };

  const clearAuthError = () => {
    setAuthError(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isLoading,
        authError,
        login,
        register,
        logout,
        clearAuthError,
        checkSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

// eslint-disable-next-line react/only-export-components -- Context files exporting a Provider + hook is a standard React pattern.
// oxlint-disable-next-line react/only-export-components
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

// eslint-disable-next-line react/only-export-components
// oxlint-disable-next-line react/only-export-components
export const useOptionalAuth = (): AuthContextType | undefined => {
  return useContext(AuthContext);
};
