import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  getSlotMeta,
  getStoredActiveSlot,
  resolveSlotSessionDetailed,
  setStoredActiveSlot,
  signInSlotAccount,
  signOutSlotAccount,
  type VerifiedSessionContext,
} from '../lib/authManager';
import { isSupabaseConfigured } from '../lib/supabase';
import type { AccountSlot, SlotAccountMeta } from '../types/domain';
import { useOnlineStatus } from './useOnlineStatus';

interface AuthContextValue {
  activeSlot: AccountSlot;
  session: VerifiedSessionContext | null;
  slotMetas: Record<AccountSlot, SlotAccountMeta | null>;
  isLoading: boolean;
  isConfigured: boolean;
  authError: string | null;
  switchSlot: (slot: AccountSlot) => Promise<void>;
  signIn: (slot: AccountSlot, email: string, password: string) => Promise<void>;
  signOutSlot: (slot: AccountSlot) => Promise<void>;
  refreshSession: () => Promise<void>;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isOnline = useOnlineStatus();
  const [activeSlot, setActiveSlot] = useState<AccountSlot>(() => getStoredActiveSlot());
  const [session, setSession] = useState<VerifiedSessionContext | null>(null);
  const [slotMetas, setSlotMetas] = useState<Record<AccountSlot, SlotAccountMeta | null>>({
    coach: getSlotMeta('coach'),
    athlete: getSlotMeta('athlete'),
  });
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const isConfigured = isSupabaseConfigured();

  const resolveSeqRef = useRef(0);
  const skipNextEffectResolveRef = useRef(false);

  const syncSlotMetasFromStorage = useCallback(() => {
    setSlotMetas({
      coach: getSlotMeta('coach'),
      athlete: getSlotMeta('athlete'),
    });
  }, []);

  const refreshSession = useCallback(async () => {
    const seq = ++resolveSeqRef.current;
    setIsLoading(true);
    try {
      const res = await resolveSlotSessionDetailed(activeSlot, isOnline);
      if (seq !== resolveSeqRef.current) return;
      setSession(res.session);
      if (res.reauthRequiredReason) {
        setAuthError(res.reauthRequiredReason);
      }
      syncSlotMetasFromStorage();
    } catch (err) {
      if (seq !== resolveSeqRef.current) return;
      setAuthError(err instanceof Error ? err.message : '認証確認に失敗しました。');
    } finally {
      if (seq === resolveSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, [activeSlot, isOnline, syncSlotMetasFromStorage]);

  useEffect(() => {
    if (skipNextEffectResolveRef.current) {
      skipNextEffectResolveRef.current = false;
      return;
    }
    void refreshSession();
  }, [refreshSession]);

  const switchSlot = useCallback(
    async (slot: AccountSlot) => {
      setAuthError(null);
      setStoredActiveSlot(slot);
      if (slot === activeSlot) {
        await refreshSession();
        return;
      }
      setIsLoading(true);
      setActiveSlot(slot);
    },
    [activeSlot, refreshSession]
  );

  const signIn = useCallback(
    async (slot: AccountSlot, email: string, password: string) => {
      setAuthError(null);
      setIsLoading(true);
      try {
        const verified = await signInSlotAccount(slot, email, password);
        resolveSeqRef.current += 1;
        if (slot !== activeSlot) {
          skipNextEffectResolveRef.current = true;
          setActiveSlot(slot);
        }
        setSession(verified);
        syncSlotMetasFromStorage();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'ログインに失敗しました。';
        setAuthError(message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [activeSlot, syncSlotMetasFromStorage]
  );

  const signOutSlot = useCallback(
    async (slot: AccountSlot) => {
      setAuthError(null);
      resolveSeqRef.current += 1;
      await signOutSlotAccount(slot);
      syncSlotMetasFromStorage();
      if (slot === activeSlot) {
        setSession(null);
      }
    },
    [activeSlot, syncSlotMetasFromStorage]
  );

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const contextValue = React.useMemo<AuthContextValue>(
    () => ({
      activeSlot,
      session,
      slotMetas,
      isLoading,
      isConfigured,
      authError,
      switchSlot,
      signIn,
      signOutSlot,
      refreshSession,
      clearAuthError,
    }),
    [
      activeSlot,
      session,
      slotMetas,
      isLoading,
      isConfigured,
      authError,
      switchSlot,
      signIn,
      signOutSlot,
      refreshSession,
      clearAuthError,
    ]
  );

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
