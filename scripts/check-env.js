#!/usr/bin/env node
/**
 * Build guard: refuse to produce a bundle that has no Supabase credentials.
 *
 * EXPO_PUBLIC_* values are inlined at build time. If they are missing, the app still builds
 * and ships, but every Supabase call fails at runtime ("Unable to load account" on the Online
 * screen). That is exactly what happened to iOS builds 150-159 after .env.local was gitignored
 * and nothing replaced it in EAS.
 *
 * Runs:
 *   - on EAS cloud builds via the `eas-build-post-install` hook in package.json
 *   - before `expo export` in `npm run build:web` (Vercel)
 *   - on demand via `npm run env:check`
 *
 * Values are resolved the same way Expo resolves them: process.env first (EAS / Vercel
 * environment variables), then the project's .env files in Expo's precedence order.
 * Set SKIP_ENV_CHECK=1 to bypass deliberately.
 */

const REQUIRED = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'];

function fail(message) {
  console.error(`[check-env] ${message}`);
  process.exit(1);
}

function loadDotenvValues() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const expoEnv = require('@expo/env');
    const result = expoEnv.parseProjectEnv(process.cwd(), { silent: true });
    // Older/newer @expo/env versions return either { env, files } or the env map itself.
    return (result && result.env) || result || {};
  } catch (error) {
    console.warn(`[check-env] Could not read .env files via @expo/env: ${error.message}`);
    return {};
  }
}

function main() {
  if (process.env.SKIP_ENV_CHECK === '1') {
    console.log('[check-env] SKIP_ENV_CHECK=1, skipping.');
    return;
  }

  const fromFiles = loadDotenvValues();
  const missing = REQUIRED.filter((name) => {
    const value = process.env[name] || fromFiles[name];
    return typeof value !== 'string' || value.trim().length === 0;
  });

  if (missing.length === 0) {
    console.log(`[check-env] OK: ${REQUIRED.join(', ')} are set.`);
    return;
  }

  const where = process.env.EAS_BUILD === 'true'
    ? `EAS build (profile "${process.env.EAS_BUILD_PROFILE || 'unknown'}")`
    : process.env.VERCEL === '1'
      ? 'Vercel build'
      : 'local build';

  fail(
    [
      `Missing ${missing.join(', ')} in this ${where}.`,
      'The app would build but every Supabase call would fail at runtime.',
      '',
      'Fix:',
      '  - EAS:    eas env:create --environment production --visibility plaintext --name <NAME> --value <VALUE>',
      '  - Vercel: Project Settings -> Environment Variables (Production)',
      '  - Local:  copy .env.example to .env.local and fill in the values',
      '',
      'Set SKIP_ENV_CHECK=1 to bypass on purpose.',
    ].join('\n')
  );
}

main();
