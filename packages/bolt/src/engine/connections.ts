// Connections (§3.3.8, §5.11.4): plain HTTP to a declared `connection`, base URL and auth resolved host-side from env
// names, so tokens never reach the guest. OAuth2: `client_credentials` tokens fetched, cached and refreshed before
// expiry; `authorization_code` consent with PKCE and a `state` bound to the signed-in member, the `redirect_uri` built
// from the host's public origin, tokens sealed through the secrets store (`per: 'workspace'` under the workspace,
// `per: 'user'` under that member) and refresh tokens rotated on use. A missing or unrefreshable token fails
// `Unauthorized { connection, reconnect }`. Every host binds the same code (`bolt start` and any other host); the host supplies
// only its secrets store, its public origin and a fetch.
import { createHash, randomBytes } from 'node:crypto';
import { decodeInput, type InputSpec } from './callables/decode.ts';
import type { CrossAnswer, CrossCall, EngineManifest } from './contracts.ts';
import type { HttpPort, HttpRequest } from './integrations/runner.ts';
import { publicFetch } from './net.ts';
import { under } from '../protocol/wire.ts';
import type { Secrets } from './secrets.ts';
import type { Json } from '../decl/values.ts';

type Env = string;
export type OAuth2 =
	| { grant: 'client_credentials'; tokenUrl: Env; clientId: Env; clientSecret: Env; scopes?: readonly string[] }
	| { grant: 'authorization_code'; per: 'workspace' | 'user'; authorizeUrl: Env; tokenUrl: Env; clientId: Env; clientSecret: Env; scopes: readonly string[] };
type Stored = { access: string; refresh?: string; exp: number };
/** What a host binds: its secrets store (tokens and env names), its public origin, and a fetch (default: `publicFetch`, L-BOLT-366). */
export type ConnectionsHost = { secrets: Pick<Secrets, 'use' | 'set' | 'clear' | 'env'>; publicUrl: string; fetch?: typeof fetch };

export const CALLBACK = '/__bolt/connections/callback';
const SKEW_MS = 60_000, STATE_MS = 10 * 60_000;
export const tokenName = (connection: string) => `oauth:${connection}`;

export function unauthorized(connection: string, reconnect: boolean, message: string): Error {
	return Object.assign(new Error(message), { kind: 'unauthorized', connection, reconnect });
}

// ponytail: pending consents live in this process; a callback landing on another replica starts again. Seal them in
// `sys_config` when a host runs one workspace on several processes.
export function oauth(m: EngineManifest, env: (name: string) => string | undefined, secrets: Pick<Secrets, 'use' | 'set' | 'clear'>, publicUrl: string,
	f: typeof fetch = fetch, now: () => number = Date.now) {
	const cache = new Map<string, Stored>();
	const pending = new Map<string, { connection: string; owner: string; member: string; verifier: string; at: number }>();
	const redirect = under(publicUrl, CALLBACK);
	const specOf = (connection: string): OAuth2 => {
		const s = (m.connections[connection] as { auth?: { oauth2?: OAuth2 } } | undefined)?.auth?.oauth2;
		if (s === undefined) throw new Error(`connection '${connection}' is not OAuth2`);
		return s;
	};
	const need = (n: string) => { const v = env(n); if (v === undefined) throw new Error(`${n} is not set`); return v; };

	async function grant(connection: string, s: OAuth2, params: { [k: string]: string }): Promise<Stored> {
		const res = await f(need(s.tokenUrl), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
			body: new URLSearchParams({ ...params, client_id: need(s.clientId), client_secret: need(s.clientSecret) }), signal: AbortSignal.timeout(30_000) });
		const j = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
		if (!res.ok || typeof j.access_token !== 'string')
			throw unauthorized(connection, s.grant === 'authorization_code', `connection '${connection}': the token endpoint answered ${res.status} ${j.error ?? ''}`.trim());
		return { access: j.access_token, ...(j.refresh_token === undefined ? {} : { refresh: j.refresh_token }), exp: now() + (j.expires_in ?? 3600) * 1000 };
	}

	return {
		/** The bearer token for a call through `connection`; `user` is the member the call is made for (none: a system actor). */
		async token(connection: string, user: string | undefined): Promise<string> {
			const s = specOf(connection);
			if (s.grant === 'client_credentials') {
				const hit = cache.get(connection);
				if (hit !== undefined && hit.exp - SKEW_MS > now()) return hit.access;
				const t = await grant(connection, s, { grant_type: 'client_credentials', ...(s.scopes === undefined ? {} : { scope: s.scopes.join(' ') }) });
				cache.set(connection, t);
				return t.access;
			}
			if (s.per === 'user' && user === undefined) throw unauthorized(connection, false, `connection '${connection}' acts for a person; a system actor has none`);
			const owner = s.per === 'workspace' ? 'workspace' : user!;
			const raw = await secrets.use(owner, tokenName(connection));
			if (raw === null) throw unauthorized(connection, true, `connection '${connection}' is not connected`);
			const stored = JSON.parse(raw) as Stored;
			if (stored.exp - SKEW_MS > now()) return stored.access;
			if (stored.refresh === undefined) throw unauthorized(connection, true, `connection '${connection}' expired; reconnect it`);
			let next: Stored;
			try {
				next = await grant(connection, s, { grant_type: 'refresh_token', refresh_token: stored.refresh });
			} catch (e) {
				await secrets.clear(owner, tokenName(connection)); // revoked consent: the member reconnects
				throw e;
			}
			await secrets.set(owner, tokenName(connection), JSON.stringify({ ...next, refresh: next.refresh ?? stored.refresh }));
			return next.access;
		},
		/** The consent redirect for `member` (an admin for `per: 'workspace'`, checked by the caller). */
		consent(connection: string, member: string): string {
			const s = specOf(connection);
			if (s.grant !== 'authorization_code') throw new Error(`connection '${connection}' needs no consent`);
			const state = randomBytes(24).toString('base64url'), verifier = randomBytes(32).toString('base64url');
			for (const [k, p] of pending) if (now() - p.at > STATE_MS) pending.delete(k);
			pending.set(state, { connection, owner: s.per === 'workspace' ? 'workspace' : member, member, verifier, at: now() });
			const url = new URL(need(s.authorizeUrl));
			for (const [k, v] of Object.entries({ response_type: 'code', client_id: need(s.clientId), redirect_uri: redirect, scope: s.scopes.join(' '), state,
				code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
			return url.href;
		},
		/** The provider's redirect back: the `state` must be one this host issued to this member, unexpired, used once. */
		async callback(state: string, code: string, member: string): Promise<string> {
			const p = pending.get(state);
			pending.delete(state);
			if (p === undefined || p.member !== member || now() - p.at > STATE_MS) throw new Error('the consent is unknown, expired or not yours; start again');
			const s = specOf(p.connection);
			const t = await grant(p.connection, s, { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: p.verifier });
			await secrets.set(p.owner, tokenName(p.connection), JSON.stringify(t));
			return p.connection;
		},
		per: (connection: string) => { const s = specOf(connection); return s.grant === 'authorization_code' ? s.per : null; },
		publicUrl,
	};
}
export type OAuth = ReturnType<typeof oauth>;

/**
 * `path` under `base`, never outside it: one leading `/` is the base itself; an absolute or `//host` path, `..`/`.`
 * segments (encoded too), a `\\`, a query or fragment, or an encoded `/`, `\\` or `%` in a segment is refused. The
 * query (a page cursor included) goes through `searchParams`, so pagination stays inside the prefix.
 */
export function target(base: string, path: string): URL {
	const root = new URL(base.endsWith('/') ? base : `${base}/`);
	const rel = path.startsWith('/') ? path.slice(1) : path;
	const refuse = () => new Error(`the path '${path}' leaves the connection's base URL`);
	if (rel.startsWith('/') || /[\\?#\s\x00-\x1f]/.test(rel)) throw refuse();
	for (const part of rel === '' ? [] : rel.split('/')) {
		let d: string;
		try { d = decodeURIComponent(part); } catch { throw refuse(); }
		if (d === '.' || d === '..' || /[\\/%\x00-\x1f]/.test(d)) throw refuse();
	}
	const url = new URL(rel, root);
	if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw refuse();
	return url;
}

/** The HTTP port over the declared connections. `as.user` is the member a call is made for (integrations pass none). */
export function connections(m: EngineManifest, env: (name: string) => string | undefined, f: typeof fetch, auth: OAuth): HttpPort {
	return {
		async request(connection, r, signal, as) {
			const spec = m.connections[connection] as { baseUrl?: string; auth?: { bearer?: string; basic?: { user: string; password: string }; header?: { name: string; value: string }; oauth2?: unknown } } | undefined;
			const base = spec?.baseUrl === undefined ? undefined : env(spec.baseUrl);
			if (base === undefined) throw new Error(`connection '${connection}' has no base URL set`);
			const url = target(base, r.path); // refused before any credential is read (L-BOLT-334)
			for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, v);
			const headers: { [k: string]: string } = { accept: 'application/json', ...(r.body === undefined ? {} : { 'content-type': 'application/json' }),
				...(r.key === undefined ? {} : { 'idempotency-key': r.key }) };
			const a = spec?.auth, need = (n: string) => { const v = env(n); if (v === undefined) throw new Error(`${n} is not set`); return v; };
			if (a?.bearer !== undefined) headers['authorization'] = `Bearer ${need(a.bearer)}`;
			else if (a?.basic !== undefined) headers['authorization'] = `Basic ${Buffer.from(`${need(a.basic.user)}:${need(a.basic.password)}`).toString('base64')}`;
			else if (a?.header !== undefined) headers[a.header.name.toLowerCase()] = need(a.header.value);
			else if (a?.oauth2 !== undefined) headers['authorization'] = `Bearer ${await auth.token(connection, as?.user)}`;
			const res = await f(url, { method: r.method, headers, signal, ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }) });
			const text = await res.text();
			let body: Json = text;
			try { body = JSON.parse(text) as Json; } catch { /* a text body stays text */ }
			return { status: res.status, body };
		},
	};
}

/** The engine's connections for a host: the OAuth2 flow (the shell's consent routes) and the HTTP port over it. */
export function bindConnections(m: EngineManifest, host: ConnectionsHost): { oauth: OAuth; http: HttpPort } {
	const f = host.fetch ?? publicFetch(), auth = oauth(m, host.secrets.env, host.secrets, host.publicUrl, f);
	return { oauth: auth, http: connections(m, host.secrets.env, f, auth) };
}

/**
 * An automation's `ctx.http(connection).<method>(path, { query, body, output })`: the call through the port, a 429 as
 * `rateLimited`, any other non-2xx as `upstream` with its status, and a body that is not `output` as `upstream`.
 */
export async function connectionCall(port: HttpPort, call: Extract<CrossCall, { op: 'facility' }>, signal: AbortSignal, user: string | undefined): Promise<CrossAnswer> {
	const [connection, path, request] = call.args as [string, string, { query?: { readonly [k: string]: string | number | boolean }; body?: Json; output?: Json } | undefined];
	const fail = (kind: 'upstream' | 'rateLimited' | 'timeout', message: string, status?: number): CrossAnswer =>
		({ ok: false, error: { kind, message, ...(status === undefined ? {} : { status }) } });
	const r: HttpRequest = { method: call.method.toUpperCase() as HttpRequest['method'], path: String(path ?? ''),
		...(request?.query === undefined ? {} : { query: Object.fromEntries(Object.entries(request.query).map(([k, v]) => [k, String(v)])) }),
		...(request?.body === undefined ? {} : { body: request.body }) };
	let res: { status: number; body: Json };
	try {
		res = await port.request(String(connection), r, signal, user === undefined ? {} : { user });
	} catch (e) {
		if (signal.aborted) return fail('timeout', `connection '${String(connection)}' did not answer in time`);
		const status = (e as { kind?: unknown }).kind === 'unauthorized' ? 401 : undefined;
		return fail('upstream', e instanceof Error ? e.message : String(e), status);
	}
	if (res.status === 429) return fail('rateLimited', `connection '${String(connection)}' is rate limited`, 429);
	if (res.status < 200 || res.status >= 300)
		return fail('upstream', `connection '${String(connection)}' answered ${res.status}${typeof res.body === 'string' && res.body !== '' ? `: ${res.body.slice(0, 200)}` : ''}`, res.status);
	if (request?.output !== undefined) {
		const d = decodeInput({ value: request.output } as unknown as InputSpec, { value: res.body });
		if (d.problems.length > 0) return fail('upstream', `connection '${String(connection)}' answered a body that is not the output: ${d.problems.map((p) => `${p.path} ${p.message}`).join('; ')}`, res.status);
	}
	return { ok: true, value: res.body };
}
