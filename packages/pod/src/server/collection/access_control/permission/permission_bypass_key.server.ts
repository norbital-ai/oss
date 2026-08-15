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

import { SECRET_PERMISSION_BYPASS_KEY } from '$lib/server/env.js';
import { getRequestEvent } from '$lib/server/request-context.js';
import { TRUSTED_PERMISSION_BYPASS_HEADER } from '$lib/host/identity.js';
import { createAsyncStore } from '$lib/server/async-store.js';

const RAW_KEY = SECRET_PERMISSION_BYPASS_KEY;

function trimmed(value: string | undefined): string | undefined {
	if (typeof value !== 'string') return undefined;
	const t = value.trim();
	return t.length > 0 ? t : undefined;
}

export function getPermissionBypassKey(): string | undefined {
	return trimmed(RAW_KEY);
}

/**
 * A hosted runtime never receives Core's global permission secret. Its HTTP adapter adds this
 * marker only after authenticating Core's ephemeral host token and strips any caller-supplied copy.
 */
function getTrustedHostBypassKey(): string | undefined {
	try {
		return getRequestEvent().request.headers.get(TRUSTED_PERMISSION_BYPASS_HEADER) === '1'
			? 'trusted-host'
			: undefined;
	} catch {
		return undefined;
	}
}

const bypassStorage = createAsyncStore<string | undefined>();

/** The bypass key active for the current async context, if any. */
export function getCurrentPermissionBypassKey(): string | undefined {
	return bypassStorage.getStore();
}

/** True only when `key` is the bypass capability active in this exact async request context. */
export function isCurrentPermissionBypassKey(key: string | undefined): boolean {
	const activeKey = getCurrentPermissionBypassKey();
	return typeof activeKey === 'string' && key === activeKey;
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
	const systemKey = getPermissionBypassKey();
	const validSecret =
		typeof systemKey === 'string' && typeof secret === 'string' && secret === systemKey;
	const activeKey = validSecret ? systemKey : getTrustedHostBypassKey();
	return bypassStorage.run(activeKey, () => fn());
}
