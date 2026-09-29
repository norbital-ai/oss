// The shell's host half (§5.10, §5.11.2, §3.9, rules 38a, 38d, 39): the session routes (`/__bolt/session/*`), the
// caller's Authority for every data route (session cookie, API key, visitor, preview-as), the visitor gates in front
// of `/q`, `/act`, `/files` and `/live`, the shell's boot, inbox, runs and settings reads, and the PWA manifest.
// Fetch-style: `handle(request)` answers its own routes and refusals, else `null` (the host falls through to
// `boltHandler`, whose `session` is `authority`). Names no host (P18).
import type { Json } from '../decl/values.ts';
import type { Authority, EngineActor, EngineManifest } from '../engine/contracts.ts';
import { BoltError } from '../engine/contracts.ts';
import { addressBucket, chargesFor, macKey, RateWindows, type RateKind } from '../engine/access/rate.ts';
import { admitVisitor } from '../engine/callables/index.ts';
import { Authorities, previewAs } from '../engine/identity/actor.ts';
import { acceptInvitation, authenticateKey, inspectInvitation } from '../engine/identity/members.ts';
import { authenticate, forget, sendCode, sha256, verifyCode, type IdentityHost, type Result } from '../engine/identity/session.ts';
import type { Envoys } from '../engine/envoys/index.ts';
import type { Runs } from '../engine/runs/index.ts';
import { basePath, BOLT, HEADERS, PATHS, SW, under } from '../protocol/wire.ts';
import { sse } from '../protocol/http.ts';
import { fingerprint, schemaSlice } from '../engine/schema/plan.ts';
import { conversationList, events, inbox, runList, settings, settingsOp, type LogLevel, type SecretsPort } from './data.ts';
import { studioOp, studioView, type StudioPort } from './studio.ts';
import { CALLBACK, type OAuth } from '../engine/connections.ts';
import { audienceOf, challengeOf, COOKIES, environmentLabel, exposure, nav, SHELL, surfaces, VISITOR_APP, type AppSpec, type ShellBoot, type ShellNotice } from './nav.ts';

const SESSION_S = 7 * 86_400, VISITOR_S = 30 * 86_400;
/** The service worker's source: it shows a pushed notice and opens its link. */
const WORKER = `self.addEventListener('push', (e) => {
	const n = e.data ? e.data.json() : {};
	e.waitUntil(self.registration.showNotification(n.title || '', { body: n.body || undefined, data: { url: new URL((n.url || '/inbox').replace(/^[/]/, ''), self.registration.scope).href } }));
});
self.addEventListener('notificationclick', (e) => {
	e.notification.close();
	e.waitUntil(self.clients.openWindow(e.notification.data.url));
});
`;

/** Host-side Turnstile verification (§5.10): `devTurnstile` in `bolt dev` and the test kit, Cloudflare's elsewhere. */
export type Turnstile = { siteKey: string; verify(token: string, ip: string): Promise<boolean> };
export const devTurnstile: Turnstile = { siteKey: 'dev', verify: async (token) => token === 'dev-pass' };
export function cloudflareTurnstile(siteKey: string, secret: string, f: typeof fetch = fetch): Turnstile {
	return {
		siteKey,
		async verify(token, ip) {
			const res = await f('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST',
				body: new URLSearchParams({ secret, response: token, remoteip: ip }), signal: AbortSignal.timeout(10_000) });
			return res.ok && ((await res.json()) as { success?: unknown }).success === true;
		},
	};
}

export type ShellHostConfig = {
	manifest: EngineManifest; identity: IdentityHost; authorities: Authorities;
	/** `bolt build`'s workspace name and the tenant handle (the PWA `id`), and brand icons. */
	workspace: { name: string; handle: string; icons?: readonly { src: string; sizes: string; type: string }[] };
	/** The client address, already resolved through the host's trusted proxies (rule 38). */
	ip(request: Request): string;
	runs?: Pick<Runs, 'view' | 'stop'>; // hook:runtime (stop)
	/** Required when an app declares `challenge: 'turnstile'`. */
	turnstile?: Turnstile;
	secrets?: SecretsPort;
	/** Envoy registration (§3.9): the page shows the handle a claim names; the signed-in member redeems it. */
	envoys?: Pick<Envoys, 'inspect' | 'redeem'>;
	/** Web push (§5.7): the VAPID public key browsers subscribe with; absent → no push offered. */
	push?: { publicKey: string };
	/** Workspace Studio (§5.10): absent → no Studio surface. */
	studio?: StudioPort;
	/** OAuth2 consent (§5.11.4), the engine's `connections`: absent → `/__bolt/connections/*` falls through. */
	connections?: OAuth;
	/** `false` only on a loopback `http://` origin (`bolt dev`). */
	secure?: boolean;
	/** `false` when the host binds no model port: the agent panel says the AI provider is not configured. */
	ai?: boolean;
	/** The deploy environment (`production`, `staging`, `development`, …): every other than production shows a badge. */
	environment?: string;
	/** A banner over every page for this member (a billing notice), or `null`; asked once per boot. */
	notice?: (auth: Authority) => Promise<ShellNotice | null>;
	/** The workspace's branding an administrator edits in Settings (name, logo: `null`, an `https:` URL or a `data:image/…` URL); absent → read-only. A refusal is a thrown `BoltError`. */
	organization?: { write(auth: Authority, branding: { name: string; logo: string | null }): Promise<void> };
	/** Where the sign-in card's "Change workspace" leads (the host's workspace picker); absent → no link. */
	apex?: string;
	uuid?: () => string;
};
type Caller = { authority: Authority | null; real: Authority | null; token: string | null; preview: ShellBoot['preview'] };
/** The preview cookie names a member id, or `team:<id>` (rule 39). */
const TEAM = 'team:';

const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, { status, headers });
const refused = (code: string, message: string, status: number, retryAfter?: number) =>
	json({ error: { code, message } }, status, retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) });
const STATUS: { readonly [code: string]: number } = { forbidden: 403, notFound: 404, rateLimited: 429, invalidCode: 400, notMember: 403,
	expired: 410, lastAdmin: 409, active: 409, conflict: 409, check: 422, unavailable: 503, upstream: 502, timeout: 504,
	// Studio refusals (the host's Studio port): a moved head or live, unresolved conflicts, a missing approval, a failed build
	stale: 409, behind: 409, conflicts: 409, notReady: 409, notApproved: 409, unaccepted: 409, buildFailed: 422 };
const answer = <T>(r: Result<T>, ok: (value: T) => Response = (value) => json({ value: value ?? null })) =>
	r.ok ? ok(r.value) : refused(r.code, r.message, STATUS[r.code] ?? 400, r.retryAfter);

function cookies(request: Request): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const at = part.indexOf('=');
		if (at > 0) out.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
	}
	return out;
}
async function body(request: Request): Promise<{ readonly [k: string]: Json }> {
	let b: unknown;
	try {
		b = await request.json();
	} catch {
		throw new BoltError('invalid', 'decode', 'the body is not JSON');
	}
	if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new BoltError('invalid', 'decode', 'the body is an object');
	return b as { readonly [k: string]: Json };
}
const text = (b: { readonly [k: string]: Json }, k: string) => typeof b[k] === 'string' ? b[k] : '';

export function shellHost(c: ShellHostConfig) {
	const m = c.manifest, h = c.identity;
	const secure = c.secure ?? true;
	const uuid = c.uuid ?? (() => crypto.randomUUID());
	const windows = new RateWindows();
	const cookie = (name: string, value: string, maxAge: number | null) =>
		`${name}=${encodeURIComponent(value)}; Path=${basePath(h.publicUrl) || '/'}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}${maxAge === null ? '' : `; Max-Age=${maxAge}`}`;
	const publicApp = (name: string | null): string | null =>
		name !== null && audienceOf(m.apps[name] as AppSpec | undefined) === 'public' ? name : null;

	/** Rule 38d: a visitor page's request runs as that app's visitor, signed in or not. */
	async function caller(request: Request): Promise<Caller> {
		const jar = cookies(request);
		const app = publicApp(request.headers.get(VISITOR_APP));
		if (app !== null) return { authority: c.authorities.visitor(app, jar.get(COOKIES.visitor) ?? uuid()), real: null, token: null, preview: null };
		const bearer = /^Bearer (nbk_\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
		if (bearer !== undefined) {
			const key = await authenticateKey(h, bearer);
			const a = key === null ? null : await c.authorities.apiKey(h.db, key);
			return { authority: a, real: a, token: null, preview: null };
		}
		const token = jar.get(COOKIES.session) ?? null;
		const s = token === null ? null : await authenticate(h, token);
		const real = s === null ? null : await c.authorities.member(h.db, s.user);
		const target = jar.get(COOKIES.preview);
		if (real !== null && target !== undefined && real.admin) {
			try {
				const team = target.startsWith(TEAM) ? target.slice(TEAM.length) : null;
				const p = await previewAs(real, c.authorities, h.db, team === null ? target : { team });
				return { authority: p.authority, real, token, preview: team === null ? { user: target, by: p.impersonatedBy } : { team, by: p.impersonatedBy } };
			} catch { /* a stale preview target falls back to the administrator */ }
		}
		return { authority: real, real, token, preview: null };
	}

	/** Rule 38d (a, b): per-IP limits, then the Turnstile token, both before decode; only `read`/`get` and generated `create`. */
	async function visitorGate(request: Request, auth: Authority, path: string): Promise<Response | null> {
		const ip = c.ip(request), app = (auth.actor as Extract<EngineActor, { kind: 'visitor' }>).app;
		const charge = (kind: RateKind) => {
			const v = windows.charge(chargesFor(auth, [kind], { ip: macKey(h.keys.ipMac, addressBucket(ip)) }), Date.now());
			return v.ok ? null : refused('rateLimited', 'rateLimited', 429, v.retryAfter);
		};
		const challenge = async () => {
			if (challengeOf(m, app) === undefined) return null;
			const token = request.headers.get(HEADERS.challenge);
			if (c.turnstile === undefined) return refused('unavailable', 'This host verifies no challenge.', 503);
			return token !== null && token !== '' && await c.turnstile.verify(token, ip) ? null : refused('forbidden', 'forbidden', 403);
		};
		const forbidden = refused('forbidden', 'Visitors may not do this.', 403);
		if (path === PATHS.q && request.method === 'POST') {
			const limited = charge('read');
			if (limited) return limited;
			const b = await request.clone().json().catch(() => null) as { reads?: unknown } | null;
			const reads = Array.isArray(b?.reads) ? b.reads as { m?: unknown; a?: unknown[] }[] : [];
			return reads.every((r) => (r.m === 'read' || r.m === 'get') && admitVisitor(auth, { read: String(r.a?.[0]) }) === null) ? null : forbidden;
		}
		if (path === PATHS.act && request.method === 'POST') {
			const limited = charge('register') ?? await challenge();
			if (limited) return limited;
			const b = await request.clone().json().catch(() => null) as { callable?: unknown } | null;
			const callable = typeof b?.callable === 'string' ? b.callable : '';
			const dot = callable.lastIndexOf('.');
			return dot > 0 && admitVisitor(auth, { act: callable.slice(0, dot), verb: callable.slice(dot + 1) }) === null ? null : forbidden;
		}
		if (path.startsWith(PATHS.files) && request.method === 'PUT') return charge('upload') ?? await challenge();
		if (path.startsWith(PATHS.files) && request.method === 'GET') return null;
		return forbidden; // `/live`, `/push`, the shell's member routes
	}

	async function boot(request: Request, x: Caller): Promise<Response> {
		const url = new URL(request.url);
		const app = publicApp(url.searchParams.get('app'));
		const logo = c.workspace.icons?.[0]?.src;
		const env = environmentLabel(c.environment);
		const ws: ShellBoot['workspace'] = { name: c.workspace.name, handle: c.workspace.handle, locale: m.workspace.locale, tz: m.workspace.tz, ...(logo === undefined ? {} : { logo }),
			...(env === null ? {} : { environment: env }), ...(c.apex === undefined ? {} : { apex: c.apex }), ...(c.organization === undefined ? {} : { organization: true as const }) };
		if (app !== null) {
			// a visitor page: the visitor cookie is minted when absent, and the page sees only its own app
			const jar = cookies(request), id = jar.get(COOKIES.visitor) ?? uuid();
			const auth = c.authorities.visitor(app, id);
			const siteKey = challengeOf(m, app) === undefined ? undefined : c.turnstile?.siteKey;
			const b: ShellBoot = { workspace: ws, actor: auth.actor, name: null, admin: false, preview: null, nav: nav(m, auth),
				surfaces: surfaces(m, auth.actor, false), inbox: 0, push: null, visitor: { app, ...(siteKey === undefined ? {} : { siteKey }) },
				catalog: exposure(m, auth), contract: fingerprint(schemaSlice(m)) };
			return json({ value: b }, 200, jar.has(COOKIES.visitor) ? {} : { 'set-cookie': cookie(COOKIES.visitor, id, VISITOR_S) });
		}
		const auth = x.authority;
		// the access pages name the workspace (and its environment) to a signed-out caller
		if (auth === null || auth.actor.kind !== 'member') return json({ error: { code: 'unauthenticated', message: 'Sign in first.', workspace: ws } }, 401);
		const [users] = await h.db.read([{ text: 'SELECT name FROM sys_user WHERE id = $1', params: [auth.actor.id] }]);
		const s = surfaces(m, auth.actor, auth.admin, c.studio !== undefined);
		const box = s.inbox ? await inbox(h.db, auth) : null;
		const notice = await c.notice?.(auth) ?? null;
		const b: ShellBoot = { workspace: ws, actor: auth.actor, name: (users!.rows[0]?.['name'] ?? null) as string | null, admin: auth.admin,
			preview: x.preview, nav: nav(m, auth), surfaces: s, inbox: box === null ? 0 : box.requests.filter((r) => r.canDecide).length + box.notices.filter((n) => !n.read).length,
			push: s.inbox ? c.push?.publicKey ?? null : null, visitor: null, catalog: exposure(m, auth), contract: fingerprint(schemaSlice(m)), ...(c.ai === false ? { aiUnconfigured: true as const } : {}), ...(notice === null ? {} : { notice }) }; // hook:decisions — also hides the Describe input (rule 16a)
		return json({ value: b });
	}

	async function session(request: Request, path: string, x: () => Promise<Caller>): Promise<Response | null> {
		const ip = c.ip(request);
		if (request.method === 'POST' && path === PATHS.session.code) {
			const b = await body(request);
			return answer(await sendCode(h, text(b, 'email'), ip));
		}
		if (request.method === 'POST' && path === PATHS.session.verify) {
			const b = await body(request);
			return answer(await verifyCode(h, text(b, 'email'), text(b, 'code'), ip),
				(s) => json({ value: { user: s.user } }, 200, { 'set-cookie': cookie(COOKIES.session, s.token, SESSION_S) }));
		}
		if (request.method === 'POST' && path === PATHS.session.signout) {
			const token = cookies(request).get(COOKIES.session);
			if (token !== undefined) {
				await h.db.write({ text: 'DELETE FROM sys_session WHERE token_hash = $1', params: [sha256(token)] });
				forget(h, token); // ponytail: this cell only; another cell serving the workspace keeps the token up to 30 s
			}
			const headers = new Headers();
			headers.append('set-cookie', cookie(COOKIES.session, '', 0));
			headers.append('set-cookie', cookie(COOKIES.preview, '', 0));
			return new Response(null, { status: 204, headers });
		}
		if (request.method === 'GET' && path.startsWith(`${PATHS.session.invitation}/`)) {
			const view = await inspectInvitation(h, decodeURIComponent(path.slice(PATHS.session.invitation.length + 1)));
			return view === null ? refused('notFound', 'No such invitation.', 404) : json({ value: view });
		}
		if (request.method === 'POST' && path === PATHS.session.invitation) {
			const b = await body(request), who = await x();
			if (who.real?.actor.kind !== 'member') return refused('unauthenticated', 'Sign in first.', 401);
			return answer(await acceptInvitation(h, { user: who.real.actor.id }, text(b, 'id')));
		}
		return null;
	}

	async function shell(request: Request, path: string, x: Caller): Promise<Response | null> {
		if (path === SHELL && request.method === 'GET') return boot(request, x);
		const auth = x.authority;
		if (auth === null || auth.actor.kind !== 'member') return refused('unauthenticated', 'Sign in first.', 401);
		const url = new URL(request.url);
		const s = surfaces(m, auth.actor, auth.admin, c.studio !== undefined);
		switch (`${request.method} ${path.slice(SHELL.length)}`) {
			case 'GET /inbox': return s.inbox ? json({ value: await inbox(h.db, auth) }) : refused('forbidden', 'No inbox for this member.', 403);
			case 'GET /runs': {
				// rule 56: the Runs surface is staff's; a holder of an automation (external included) reads its runs through `bolt.runs`
				const one = url.searchParams.get('automation') ?? undefined;
				if (!s.runs && !(one !== undefined && auth.automations.includes(one)) && url.searchParams.get('id') === null)
					return refused('forbidden', 'No runs for this member.', 403);
				const id = url.searchParams.get('id');
				if (id === null) return json({ value: await runList(h.db, auth, Number(url.searchParams.get('limit') ?? 100) || 100, one) });
				const run = await c.runs?.view(auth, id) ?? null;
				return run === null ? refused('notFound', 'Not found or no access.', 404) : json({ value: run });
			}
			case 'POST /runs/stop': { // hook:runtime — rule 56: whoever reads the run in full may stop it
				const id = (await body(request))['id'];
				const run = typeof id === 'string' ? await c.runs?.stop(auth, id) ?? null : null;
				return run === null ? refused('notFound', 'Not found or no access.', 404) : json({ value: run });
			}
			case 'GET /conversations': // hook:agent-ui
				return s.conversations ? json({ value: await conversationList(h.db, auth, Object.entries(m.envoys).filter(([, e]) => (e as { audience?: unknown }).audience === 'public').map(([n]) => n)) }) : refused('forbidden', 'No conversations for this member.', 403);
			case 'GET /settings': return answer(await settings(h, m, auth, c.secrets));
			case 'POST /settings': {
				const b = await body(request);
				const input = b['input'];
				return answer(await settingsOp(h, m, auth, text(b, 'op'), typeof input === 'object' && input !== null && !Array.isArray(input) ? input as { readonly [k: string]: Json } : {}, c.secrets));
			}
			case 'POST /organization': {
				// L-COL-199: the workspace's name and logo, an administrator's (never a previewed member's)
				if (c.organization === undefined) return refused('unavailable', 'This host keeps the branding in the workspace source.', 503);
				if (!auth.admin) return refused('forbidden', 'Only an administrator edits the organization.', 403);
				const b = await body(request), logo = b['logo'] ?? null;
				if (text(b, 'name').trim() === '' || (logo !== null && typeof logo !== 'string')) throw new BoltError('invalid', 'decode', 'the body is { name, logo: string | null }');
				await c.organization.write(auth, { name: text(b, 'name').trim(), logo });
				return json({ value: null });
			}
			case 'GET /logs': {
				const p = url.searchParams, level = p.get('level'), conversation = p.get('conversation');
				return answer(await events(h.db, auth, { ...(p.get('before') === null ? {} : { before: p.get('before')! }), ...(p.get('after') === null ? {} : { after: p.get('after')! }),
					...(level === 'info' || level === 'warn' || level === 'error' ? { level: level as LogLevel } : {}), ...(p.get('q') === null ? {} : { text: p.get('q')! }),
					...(conversation === null ? {} : { conversation }) }));
			}
			case 'GET /studio': case 'POST /studio': {
				if (!s.studio || c.studio === undefined) return refused('forbidden', 'Studio is for staff members on a host that serves it.', 403);
				if (request.method === 'GET') return json({ value: studioView(await c.studio.state(auth)) });
				const op = studioOp((await body(request))['op'] ?? null);
				if (op === null) return refused('check', 'The Studio operation is malformed.', 422);
				return json({ value: studioView(await c.studio.run(auth, op)) });
			}
			case 'GET /studio/events': { // pushed authoring frames (build log lines, a moved head); nothing is polled
				const watch = c.studio?.watch?.bind(c.studio);
				if (!s.studio || watch === undefined) return refused('forbidden', 'Studio is for staff members on a host that streams it.', 403);
				return sse((write) => watch(auth, (frame) => write(`data: ${JSON.stringify(frame)}\n\n`)));
			}
			case 'POST /preview': {
				// rule 39: only the real administrator may start or end a preview, of a member or a team
				const b = await body(request), user = b['user'], team = b['team'];
				if (x.real === null || !x.real.admin) return refused('forbidden', 'Only an administrator can preview as a member or team.', 403);
				if (user === null || team === null) return new Response(null, { status: 204, headers: { 'set-cookie': cookie(COOKIES.preview, '', 0) } });
				if (typeof team === 'string') {
					await previewAs(x.real, c.authorities, h.db, { team });
					return new Response(null, { status: 204, headers: { 'set-cookie': cookie(COOKIES.preview, `${TEAM}${team}`, null) } });
				}
				if (typeof user !== 'string') throw new BoltError('invalid', 'decode', 'the body is { user } or { team }');
				await previewAs(x.real, c.authorities, h.db, user);
				return new Response(null, { status: 204, headers: { 'set-cookie': cookie(COOKIES.preview, user, null) } });
			}
			case 'GET /explain': {
				// `access.explain` (L-BOLT-234): the caller's own Authority, or (administrators) a member's or team's as a preview compiles it
				const user = url.searchParams.get('user'), team = url.searchParams.get('team');
				let a: Authority = auth;
				if (user !== null || team !== null) {
					if (x.real === null || !x.real.admin) return refused('forbidden', 'Only an administrator can explain another member or team.', 403);
					a = (await previewAs(x.real, c.authorities, h.db, team !== null ? { team } : user!)).authority;
				}
				const { key: _key, ...explained } = a;
				return json({ value: explained });
			}
			case 'GET /register': {
				// read-only: safe for mail scanners and link previews; the page shows the handle before anything links
				if (c.envoys === undefined) return refused('unavailable', 'This host links no channel handles.', 503);
				return json({ value: await c.envoys.inspect(url.searchParams.get('claim') ?? '') });
			}
			case 'POST /register': {
				// the real member claims the handle, never a previewed one (rule 39); replay only when ticked
				if (c.envoys === undefined) return refused('unavailable', 'This host links no channel handles.', 503);
				if (x.real?.actor.kind !== 'member') return refused('unauthenticated', 'Sign in first.', 401);
				const b = await body(request);
				return json({ value: await c.envoys.redeem(text(b, 'claim'), x.real, { replay: b['replay'] === true }) });
			}
		}
		return null;
	}

	/** `GET /manifest.webmanifest` (§5.10, L-BOLT-295): scope and start_url from the configured public origin, never `Host`. */
	function webmanifest(): Response {
		const scope = under(h.publicUrl, '/');
		return new Response(JSON.stringify({ id: c.workspace.handle, name: c.workspace.name, short_name: c.workspace.name, scope, start_url: scope,
			display: 'standalone', icons: c.workspace.icons ?? [] }), { headers: { 'content-type': 'application/manifest+json' } });
	}

	/** `GET /__bolt/connections/<name>/connect` for a member (an administrator for `per: 'workspace'`), then the provider's redirect back. */
	async function connect(auth: OAuth, request: Request, path: string, a: Authority | null): Promise<Response> {
		if (a === null || a.actor.kind !== 'member') return refused('unauthenticated', 'Sign in first.', 401);
		const url = new URL(request.url);
		try {
			if (path === CALLBACK) {
				const connection = await auth.callback(url.searchParams.get('state') ?? '', url.searchParams.get('code') ?? '', a.actor.id);
				return new Response(null, { status: 302, headers: { location: under(auth.publicUrl, `/?connected=${encodeURIComponent(connection)}`) } });
			}
			const name = /^\/__bolt\/connections\/([\w-]+)\/connect$/.exec(path)?.[1];
			if (name === undefined || m.connections[name] === undefined) return refused('notFound', 'no such connection', 404);
			if (auth.per(name) === 'workspace' && !a.admin) return refused('forbidden', 'Only an administrator connects this workspace.', 403);
			return new Response(null, { status: 302, headers: { location: auth.consent(name, a.actor.id) } });
		} catch (x) {
			return refused('invalid', x instanceof Error ? x.message : String(x), 400);
		}
	}

	return {
		/** `boltHandler`'s `session`: the caller's Authority, or `null` (401). */
		authority: async (request: Request) => (await caller(request)).authority,
		async handle(request: Request): Promise<Response | null> {
			const path = new URL(request.url).pathname;
			try {
				if (path === '/manifest.webmanifest' && request.method === 'GET') return webmanifest();
				if (path === SW && request.method === 'GET') return new Response(WORKER, { headers: { 'content-type': 'text/javascript', 'service-worker-allowed': '/', 'cache-control': 'no-cache' } });
				// the engine's default registration link: the shell's page for it
				if (path === `${BOLT}/envoys/register` && request.method === 'GET')
					return new Response(null, { status: 303, headers: { location: under(h.publicUrl, `/register/${encodeURIComponent(new URL(request.url).searchParams.get('claim') ?? '')}`) } });
				let memo: Promise<Caller> | undefined;
				const x = () => memo ??= caller(request);
				if (path.startsWith(`${BOLT}/session/`)) return await session(request, path, x);
				if (!path.startsWith(`${BOLT}/`)) return null;
				const who = await x();
				if (who.authority?.actor.kind === 'visitor') return await visitorGate(request, who.authority, path);
				if (path === SHELL || path.startsWith(`${SHELL}/`)) return await shell(request, path, who);
				if (c.connections !== undefined && path.startsWith(`${BOLT}/connections/`) && request.method === 'GET') return await connect(c.connections, request, path, who.authority);
				return null;
			} catch (e) {
				return e instanceof BoltError ? refused(e.code, e.message, STATUS[e.code] ?? (e.code === 'invalid' ? 400 : 500))
					: refused('internal', 'The request failed.', 500);
			}
		},
	};
}
export type ShellHost = ReturnType<typeof shellHost>;
