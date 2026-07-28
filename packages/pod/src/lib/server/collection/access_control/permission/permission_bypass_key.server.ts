/**
 * Canonical resolver for `SECRET_PERMISSION_BYPASS_KEY`.
 *
 * Single source of truth for "what is the privilege-bypass key right now".
 * Every code path that needs to skip policy checks (system actors,
 * background jobs, scoped lookups) goes through this module so the env
 * variable is read in exactly one place and the behavior is uniform:
 *
 * - `getPermissionBypassKey()` returns the trimmed key, or `undefined` if
 *   the env var is unset.
 * - `requirePermissionBypassKey()` throws if the env var is unset for
 *   code paths that refuse to operate without the bypass.
 */

import { SECRET_PERMISSION_BYPASS_KEY } from '$lib/server/run/env.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const RAW_KEY = SECRET_PERMISSION_BYPASS_KEY;

function trimmed(value: string | undefined): string | undefined {
	if (typeof value !== 'string') return undefined;
	const t = value.trim();
	return t.length > 0 ? t : undefined;
}

export function getPermissionBypassKey(): string | undefined {
	return trimmed(RAW_KEY);
}

export function requirePermissionBypassKey(): string {
	const key = trimmed(RAW_KEY);
	if (!key) {
		throw new Error('System config error: Bypass key not configured');
	}
	return key;
}

const bypassStorage = new AsyncLocalStorage<string | undefined>();

/** The bypass key active for the current async context, if any. */
export function getCurrentPermissionBypassKey(): string | undefined {
	return bypassStorage.getStore();
}

/**
 * Runs `fn` with the system permission-bypass key active. Policy resolution
 * skips row-level checks for the duration of the call.
 */
export async function runWithPermissionBypassAsync<T>(fn: () => Promise<T> | T): Promise<T> {
	const key = getPermissionBypassKey();
	return bypassStorage.run(key, () => fn());
}

/**
 * Runs `fn` with `secret` as the active bypass key when it matches the
 * configured system bypass key. Otherwise runs `fn` with no bypass.
 */
export async function runWithBypassSecretIfValidAsync<T>(
	secret: string | undefined,
	fn: () => Promise<T> | T
): Promise<T> {
	if (secret === undefined) return fn();
	const systemKey = getPermissionBypassKey();
	const valid = typeof systemKey === 'string' && secret === systemKey;
	return bypassStorage.run(valid ? systemKey : undefined, () => fn());
}
