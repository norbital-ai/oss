/**
 * Admin team impersonation from the pod shell.
 *
 * The impersonation scope is Core's: Core swaps the admin's `team_members` in the base scope it
 * forwards to the tenant runtime whenever the `X-IMPERSONATE` cookie names teams. The account menu
 * picker lives in the shell, so writing that cookie here and reloading the page is the whole round
 * trip — the next request Core proxies resolves with the simulated teams' policy scope, and the
 * sidebar's team list was delivered with the shell data (see `shell-data.server.ts`).
 *
 * The cookie format must match Core's `apps/core/src/lib/access_control/impersonate.ts`
 * (`encodeURIComponent(JSON.stringify(uuid[]))`). It is plain, not signed: it can only restrict an
 * already-authenticated admin to a subset of teams that exist in the tenant directory, and Core
 * re-resolves the team rows on every request.
 */

export const IMPERSONATE_COOKIE_NAME = 'X-IMPERSONATE';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseTeamIds(raw: string | undefined | null): string[] {
	if (raw === undefined || raw === null) return [];
	const trimmed = raw.trim();
	if (trimmed === '') return [];
	let normalized: string;
	try {
		normalized = decodeURIComponent(trimmed);
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(normalized) as unknown;
	} catch {
		return [];
	}
	if (
		!Array.isArray(parsed) ||
		!parsed.every((teamId) => typeof teamId === 'string' && UUID_RE.test(teamId))
	) {
		return [];
	}
	return parsed;
}

export function readImpersonationTeamIds(): string[] {
	if (typeof document === 'undefined') return [];
	const match = document.cookie.match(
		new RegExp(`(?:^|; )${IMPERSONATE_COOKIE_NAME}=([^;]*)`)
	);
	return parseTeamIds(match?.[1] ?? null);
}

export function writeImpersonationTeamIds(teamIds: readonly string[]): void {
	if (typeof document === 'undefined') return;
	const value = encodeURIComponent(JSON.stringify(Array.from(new Set(teamIds.filter(Boolean)))));
	const secure = location.protocol === 'https:';
	document.cookie = `${IMPERSONATE_COOKIE_NAME}=${value}; Path=/; SameSite=Lax${
		secure ? '; Secure' : ''
	}`;
}
