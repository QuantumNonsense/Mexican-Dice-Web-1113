/**
 * Supabase Authentication Helpers
 *
 * AUTH STRATEGY:
 * We use Supabase Anonymous Auth for a frictionless casual game experience.
 * Users get a persistent auth session without any signup/login flow.
 *
 * Session persistence is handled by the Supabase client itself (see src/lib/supabase.ts, which
 * gives it an AsyncStorage adapter on native). Do NOT copy tokens around by hand: refresh tokens
 * rotate, so a hand-written copy goes stale and every restart would mint a new anonymous user.
 *
 * FUTURE: Can be upgraded to email/OAuth without breaking existing code.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { PostgrestError, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from './supabase';
import { getOrCreateUserDisplayName, setUserDisplayName } from '../identity/userDisplayName';
import { generateRandomColorAnimalName, normalizeColorAnimalName } from './colorAnimalName';

/** Key used by older app versions that persisted the session by hand. Read once, then removed. */
const LEGACY_AUTH_SESSION_KEY = 'mexican-dice-auth-session';

/**
 * Get the currently authenticated user
 * Returns null if no session exists
 */
export async function getCurrentUser(): Promise<User | null> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.user) {
      return session.user;
    }

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error) {
      // "Auth session missing" is the normal not-signed-in case; don't spam the console for it.
      if (__DEV__ && !/session/i.test(error.message)) {
        console.warn('Error getting current user:', error);
      }
      return null;
    }

    return user;
  } catch (err) {
    console.error('Unexpected error getting user:', err);
    return null;
  }
}

/**
 * One-time migration: older builds stored the session JSON themselves. If the client has no
 * session of its own yet, try to adopt that one so existing players keep their identity.
 * The key is removed afterwards regardless of outcome.
 */
async function adoptLegacySession(): Promise<User | null> {
  try {
    const stored = await AsyncStorage.getItem(LEGACY_AUTH_SESSION_KEY);
    if (!stored) return null;

    await AsyncStorage.removeItem(LEGACY_AUTH_SESSION_KEY);

    const parsed = JSON.parse(stored) as { access_token?: string; refresh_token?: string };
    if (!parsed?.access_token || !parsed?.refresh_token) return null;

    const { data, error } = await supabase.auth.setSession({
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
    });

    if (error || !data.user) {
      if (__DEV__) console.warn('Legacy session could not be restored:', error?.message);
      return null;
    }

    if (__DEV__) console.log('✅ Legacy session adopted:', data.user.id);
    return data.user;
  } catch (err) {
    if (__DEV__) console.warn('Legacy session migration failed:', err);
    return null;
  }
}

let signInInFlight: Promise<User> | null = null;

/**
 * Sign in anonymously or restore existing session
 * Creates a persistent anonymous user if none exists
 *
 * Concurrent callers share one in-flight sign-in so a cold start cannot create several users.
 */
export async function signInOrCreateUser(): Promise<User> {
  if (signInInFlight) return signInInFlight;

  signInInFlight = (async () => {
    try {
      if (!isSupabaseConfigured) {
        // Fail with the real reason instead of a misleading network error against the placeholder host.
        throw new Error(
          'Supabase credentials are missing from this build (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY).'
        );
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session?.user) {
        return session.user;
      }

      const legacyUser = await adoptLegacySession();
      if (legacyUser) {
        return legacyUser;
      }

      if (__DEV__) console.log('🔐 Creating anonymous auth session...');

      const { data, error } = await supabase.auth.signInAnonymously();

      if (error) {
        throw new Error(`Anonymous sign-in failed: ${error.message}`);
      }

      if (!data.user) {
        throw new Error('No user returned from anonymous sign-in');
      }

      if (__DEV__) console.log('✅ Anonymous auth session created:', data.user.id);
      return data.user;
    } finally {
      signInInFlight = null;
    }
  })();

  return signInInFlight;
}

/**
 * Initialize auth on app launch
 * Ensures user has a valid session before accessing protected features
 */
export async function initializeAuth(): Promise<User> {
  return signInOrCreateUser();
}

/**
 * Sign out (mainly for testing/dev purposes)
 */
export async function signOut(): Promise<void> {
  try {
    await supabase.auth.signOut();
    await AsyncStorage.removeItem(LEGACY_AUTH_SESSION_KEY);
    profileCache = null;
    if (__DEV__) console.log('✅ Signed out successfully');
  } catch (err) {
    console.error('Error signing out:', err);
  }
}

/**
 * Listen for auth state changes
 * Useful for updating UI when session expires or changes
 */
export function onAuthStateChange(callback: (user: User | null) => void) {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });

  return subscription;
}

/**
 * Get the current user ID (convenience helper)
 * Throws if not authenticated
 */
export async function requireUserId(): Promise<string> {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error('User must be authenticated');
  }

  return user.id;
}

/**
 * User profile type matching public.users table
 */
export type UserProfile = {
  id: string;
  username: string;
  created_at?: string;
};

const isNullOrWhitespace = (value?: string | null) => !value || value.trim().length === 0;

const MAX_USERNAME_ATTEMPTS = 10;
const UNIQUE_USERNAME_CODE = '23505';
const UNIQUE_USERNAME_CONSTRAINT = 'users_username_key';

const isUniqueUsernameError = (error?: PostgrestError | null) => {
  if (!error) return false;
  if (error.code !== UNIQUE_USERNAME_CODE) return false;
  if (!error.message) return true;
  return error.message.includes(UNIQUE_USERNAME_CONSTRAINT);
};

const normalizeCandidate = (value?: string | null) => {
  if (!value || isNullOrWhitespace(value)) {
    return null;
  }
  const normalized = normalizeColorAnimalName(value);
  return normalized || null;
};

const nextUsernameCandidate = (attempt: number, preferred?: string | null) => {
  if (attempt === 0) {
    const normalizedPreferred = normalizeCandidate(preferred);
    if (normalizedPreferred) {
      return normalizedPreferred;
    }
  }
  const raw = generateRandomColorAnimalName();
  const normalizedRandom = normalizeColorAnimalName(raw);

  if (!normalizedRandom) {
    throw new Error('Failed to generate username');
  }

  return normalizedRandom;
};

async function ensureColorAnimalUsername(userId: string, fallbackSource?: string | null) {
  const preferredSource =
    !isNullOrWhitespace(fallbackSource) ? fallbackSource : await getOrCreateUserDisplayName();

  for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt += 1) {
    const candidate = nextUsernameCandidate(attempt, preferredSource);

    const { error } = await supabase
      .from('users')
      .update({ username: candidate })
      .eq('id', userId)
      .select('username')
      .single();

    if (!error) {
      await setUserDisplayName(candidate);
      return candidate;
    }

    if (isUniqueUsernameError(error)) {
      console.warn(
        `⚠️ Username "${candidate}" already taken. Retrying (${attempt + 1}/${MAX_USERNAME_ATTEMPTS})`
      );
      continue;
    }

    console.error('⚠️ Failed to assign username:', error);
    throw new Error(error?.message ?? 'Failed to assign username');
  }

  throw new Error('Failed to assign username after multiple attempts');
}

async function createProfileWithUniqueUsername(userId: string): Promise<UserProfile> {
  const preferredSource = await getOrCreateUserDisplayName();

  for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt += 1) {
    const candidate = nextUsernameCandidate(attempt, preferredSource);

    const { data, error } = await supabase
      .from('users')
      .insert({
        id: userId,
        username: candidate,
      })
      .select()
      .single();

    if (!error && data) {
      await setUserDisplayName(candidate);
      if (__DEV__) console.log('✅ User profile created:', data.username);
      return data as UserProfile;
    }

    if (isUniqueUsernameError(error)) {
      // Could be a username collision, or the profile row itself already exists (created by a
      // concurrent caller). Re-read before retrying with another name.
      const { data: existing } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (existing && !isNullOrWhitespace(existing.username)) {
        await setUserDisplayName(existing.username);
        return existing as UserProfile;
      }
      console.warn(
        `⚠️ Username collision for "${candidate}". Retrying (${attempt + 1}/${MAX_USERNAME_ATTEMPTS})`
      );
      continue;
    }

    console.error('❌ Error creating user profile:', error);
    throw new Error(`Failed to create user profile: ${error?.message ?? 'Unknown error'}`);
  }

  throw new Error('Failed to create user profile after multiple username attempts');
}

let profileCache: UserProfile | null = null;
let profileInFlight: Promise<UserProfile> | null = null;

async function loadOrCreateProfile(): Promise<UserProfile> {
  const user = await initializeAuth();

  if (!user) {
    throw new Error('Failed to authenticate user');
  }

  const { data: existingProfile, error: profileError } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) {
    console.error('❌ Error loading user profile:', profileError);
    throw new Error(profileError.message ?? 'Failed to load user profile');
  }

  if (existingProfile) {
    if (isNullOrWhitespace(existingProfile.username)) {
      if (__DEV__) console.log('🧼 Repairing missing username for user:', user.id);
      const repairedUsername = await ensureColorAnimalUsername(user.id);
      return {
        id: existingProfile.id,
        username: repairedUsername,
        created_at: existingProfile.created_at,
      };
    }

    // Upgrade old Player-XXXX format usernames
    const isOldFormat = /^Player-\d{4}$/.test(existingProfile.username);
    if (isOldFormat) {
      const newUsername = await ensureColorAnimalUsername(user.id);
      return {
        id: existingProfile.id,
        username: newUsername,
        created_at: existingProfile.created_at,
      };
    }

    await setUserDisplayName(existingProfile.username);
    return {
      id: existingProfile.id,
      username: existingProfile.username,
      created_at: existingProfile.created_at,
    };
  }

  const newProfile = await createProfileWithUniqueUsername(user.id);
  return {
    id: newProfile.id,
    username: newProfile.username,
    created_at: newProfile.created_at,
  };
}

/**
 * Ensure the current authenticated user has a profile in public.users
 *
 * 1. Ensures user is authenticated (creates anonymous session if needed)
 * 2. Checks if user has a row in public.users
 * 3. If no row exists, generates a friendly username and creates one
 * 4. Returns the user profile with id and username
 *
 * Concurrent callers share one in-flight request and later callers get a cached profile for the
 * current session, so startup code paths cannot race each other into duplicate users/rows.
 */
export async function ensureUserProfile(): Promise<UserProfile> {
  if (profileCache) {
    // Make sure the cached profile still belongs to the active session.
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.user?.id === profileCache.id) {
      return profileCache;
    }
    profileCache = null;
  }

  if (profileInFlight) return profileInFlight;

  profileInFlight = (async () => {
    try {
      const profile = await loadOrCreateProfile();
      profileCache = profile;
      return profile;
    } catch (err) {
      console.error('❌ Failed to ensure user profile:', err);

      if (err instanceof Error) {
        if (err.message.includes('RLS')) {
          throw new Error('Database access denied. Please check RLS policies.');
        }
        if (err.message.includes('authenticate')) {
          throw new Error('Authentication failed. Please check your connection.');
        }
        throw err;
      }

      throw new Error('Failed to load or create user profile');
    } finally {
      profileInFlight = null;
    }
  })();

  return profileInFlight;
}

/** Drop the cached profile (e.g. after the user renames themselves). */
export function invalidateUserProfileCache(): void {
  profileCache = null;
}
