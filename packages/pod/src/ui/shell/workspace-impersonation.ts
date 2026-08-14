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

import { z } from 'zod';

export const IMPERSONATE_COOKIE_NAME = 'X-IMPERSONATE';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const teamIdsSchema = z.array(z.string().regex(UUID_RE));

/** Decodes Core's X-IMPERSONATE cookie payload into a list of team UUIDs. */
// stupidity:allow Q3 -- cookie payload decoder
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
	try {
		const parsed = teamIdsSchema.safeParse(JSON.parse(normalized));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

/** Reads the impersonation cookie from the document, or an empty list off-browser. */
export function readImpersonationTeamIds(): string[] {
	if (typeof document === 'undefined') return [];
	const match = document.cookie.match(new RegExp(`(?:^|; )${IMPERSONATE_COOKIE_NAME}=([^;]*)`));
	return parseTeamIds(match?.[1] ?? null);
}

/** Writes the impersonation cookie so the next proxied request resolves the simulated teams. */
export function writeImpersonationTeamIds(teamIds: readonly string[]): void {
	if (typeof document === 'undefined') return;
	const value = encodeURIComponent(JSON.stringify(Array.from(new Set(teamIds.filter(Boolean)))));
	const secure = location.protocol === 'https:';
	document.cookie = `${IMPERSONATE_COOKIE_NAME}=${value}; Path=/; SameSite=Lax${
		secure ? '; Secure' : ''
	}`;
}
