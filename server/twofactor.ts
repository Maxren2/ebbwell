import type { Config } from './config.ts';
import type { Store, User } from './db.ts';
import { generateRecoveryCodes, hashRecoveryCode, looksLikeRecoveryCode, verifyTotp } from './totp.ts';

/**
 * Checks a TOTP code or a recovery code for a user with 2FA enabled.
 * Accepted TOTP steps can't be replayed; recovery codes are single-use.
 */
export function checkSecondFactor(store: Store, userId: string, input: string): 'totp' | 'recovery' | null {
  const state = store.getTotp(userId);
  if (!state) return null;
  if (looksLikeRecoveryCode(input)) {
    const hash = hashRecoveryCode(input);
    if (!state.recovery.includes(hash)) return null;
    store.setTotp(userId, { ...state, recovery: state.recovery.filter((h) => h !== hash) });
    return 'recovery';
  }
  const step = verifyTotp(state.secret, input, state.lastStep);
  if (step === null) return null;
  store.setTotp(userId, { ...state, lastStep: step });
  return 'totp';
}

/** Replaces the recovery codes; returns the new plaintext codes (shown once). */
export function renewRecoveryCodes(store: Store, userId: string): string[] {
  const state = store.getTotp(userId);
  if (!state) throw new Error('2FA not enabled');
  const codes = generateRecoveryCodes();
  store.setTotp(userId, { ...state, recovery: codes.map(hashRecoveryCode) });
  return codes;
}

export const twoFactorSetupRequired = (config: Config, user: User) =>
  user.kind === 'local' && config.LOCAL_2FA === 'required' && !user.twoFactor;

/** Where a local user goes after signing in: pending password change, then pending 2FA setup, then the app. */
export const nextStep = (config: Config, user: User) =>
  user.mustChangePassword ? '/auth/password' : twoFactorSetupRequired(config, user) ? '/auth/2fa/setup' : '/';
