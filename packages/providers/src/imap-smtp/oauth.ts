// OAuth for a mailbox channel, owned by the channel (not by Norbital, not by bolt's connections): the tenant's own app
// registration, authorization code with PKCE, the callback on the channel's own webhook, and refresh on use. Nothing
// here is tied to a member: the `state` is bound to one pairing attempt and lives ten minutes.
import { createHash, randomBytes } from 'node:crypto';

/** Where a provider's authorization server is, and what the mailbox needs from it. */
export type OAuthApp = { authorizeUrl: string; tokenUrl: string; scopes: readonly string[]; params?: { readonly [k: string]: string } };
export type Tokens = { access: string; refresh: string | null; exp: number };
/** The token endpoint refused: `revoked` when only a new sign-in helps (`invalid_grant`). */
export class OAuthRefused extends Error {
	readonly revoked: boolean;
	constructor(message: string, revoked: boolean) { super(message); this.revoked = revoked; }
}

export const STATE_MS = 10 * 60_000;
const SKEW_MS = 60_000;

/** One sign-in attempt: the `state` the callback must echo and the PKCE verifier its code is exchanged with. */
export function attempt(): { state: string; verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	return { state: randomBytes(24).toString('base64url'), verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(app: OAuthApp, clientId: string, redirect: string, state: string, challenge: string, hint?: string): string {
	const url = new URL(app.authorizeUrl);
	for (const [k, v] of Object.entries({ ...app.params, response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: app.scopes.join(' '), state,
		code_challenge: challenge, code_challenge_method: 'S256', ...(hint === undefined ? {} : { login_hint: hint }) })) url.searchParams.set(k, v);
	return url.href;
}

/** One token request (`authorization_code` or `refresh_token`). */
export async function grant(f: typeof fetch, app: OAuthApp, client: { id: string; secret: string }, params: { [k: string]: string }, now: number): Promise<Tokens> {
	const res = await f(app.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
		body: new URLSearchParams({ ...params, client_id: client.id, client_secret: client.secret }), signal: AbortSignal.timeout(30_000) });
	const j = await res.json().catch(() => ({})) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
	if (!res.ok || typeof j.access_token !== 'string') {
		const code = typeof j.error === 'string' ? j.error : String(res.status);
		throw new OAuthRefused(`the sign-in was refused (${code})${typeof j.error_description === 'string' ? `: ${j.error_description.split('\n')[0]}` : ''}`,
			code === 'invalid_grant' || code === 'unauthorized_client' || code === 'invalid_client');
	}
	return { access: j.access_token, refresh: typeof j.refresh_token === 'string' ? j.refresh_token : null,
		exp: now + (typeof j.expires_in === 'number' ? j.expires_in : 3600) * 1000 };
}

/** `t` if it is still good, else refreshed (the old refresh token kept when the provider does not rotate it). */
export async function fresh(f: typeof fetch, app: OAuthApp, client: { id: string; secret: string }, t: Tokens, now: number): Promise<Tokens> {
	if (t.exp - SKEW_MS > now) return t;
	if (t.refresh === null) throw new OAuthRefused('the sign-in expired and gave no refresh token', true);
	const next = await grant(f, app, client, { grant_type: 'refresh_token', refresh_token: t.refresh, scope: app.scopes.join(' ') }, now);
	return { ...next, refresh: next.refresh ?? t.refresh };
}
