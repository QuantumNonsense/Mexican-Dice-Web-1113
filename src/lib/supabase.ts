import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, processLock } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/** False when the build was produced without Supabase credentials (see scripts/check-env.js). */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
  // Never throw at import time (it would crash the whole app); surface loudly instead.
  console.error(
    '[supabase] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are not set. Online features will fail.'
  );
}

const isWeb = Platform.OS === 'web';

/**
 * On native there is no localStorage, so without an explicit storage adapter supabase-js keeps the
 * session in memory only and every cold start would create a brand-new anonymous user (refresh tokens
 * rotate, so a one-off copy of the session goes stale). AsyncStorage keeps the session, and the
 * client keeps that copy updated on every refresh.
 */
export const supabase = createClient(
  supabaseUrl ?? 'https://invalid.supabase.co',
  supabaseAnonKey ?? 'missing-anon-key',
  {
    auth: {
      ...(isWeb ? {} : { storage: AsyncStorage }),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: isWeb,
      lock: processLock,
    },
  }
);

// Supabase recommends pausing token refresh while the app is backgrounded on native.
if (!isWeb && typeof AppState?.addEventListener === 'function') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}
