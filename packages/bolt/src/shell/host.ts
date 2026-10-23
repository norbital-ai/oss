// The shell's host half (§5.10, §5.11.2, §3.9, rules 38a, 38d, 39): the session routes (`/__bolt/session/*`), the
// caller's Authority for every data route (session cookie, API key, visitor, preview-as), the visitor gates in front
// of `/q`, `/act`, `/files` and `/live`, the shell's boot, inbox, runs and settings reads, and the PWA manifest.
// Native handlers answer their own routes and refusals, otherwise None; BoltHost composes them in the fixed order.
import {
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Queue,
	Redacted,
	Result,
	Schema,
	Stream
} from 'effect';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse';
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse';
import * as Headers from 'effect/unstable/http/Headers';
import { Unavailable } from '../decl/errors.ts';
import { Activation, Manifest, Identity, Runs } from '../engine/services.ts';
import { TenantDb } from '../engine/db/tenant-db.ts';
import { Secrets } from '../engine/secrets.ts';
import {
	header,
	invalid,
	RateLimits,
	requestActRate,
	requestReadRate,
	readAdmitted,
	requestBody,
	requestUrl,
	responseError,
	SessionAuthority
} from '../protocol/http.ts';
import { QBody, ActBody, SessionCode } from '../protocol/schema.ts';
import { sseResponse } from '../protocol/sse.ts';
import type { Handler } from '../protocol/host.ts';
import { requestKiosk, kioskAuthority, kioskBoot } from './public/kiosk.ts';
import type { EngineManifest } from '../engine/manifest.ts';
import type { Json } from '../decl/values.ts';
import type { Authority, EngineActor } from '../engine/contracts.ts';
import { type EngineError } from '../engine/errors.ts';
import { BoltError, CODES, PHASES } from '../protocol/errors.ts';
import { addressBucket, chargesFor, macKey, type RateKind } from '../engine/access/rate.ts';
import { admitVisitor } from '../engine/callables/index.ts';
import { Authorities, previewAs } from '../engine/identity/actor.ts';
import {
	acceptInvitation,
	authenticateKey,
	inspectInvitation
} from '../engine/identity/members.ts';
import {
	authenticate,
	forget,
	requireAdmin,
	sendCode,
	sha256,
	SIGNUP_KEY,
	verifyCode,
	type IdentityHost
} from '../engine/identity/session.ts';
import { BOLT, HEADERS, PATHS, SW, basePath, under } from '../protocol/wire.ts';
import { fingerprint, schemaSlice } from '../engine/schema/plan.ts';
import { events, type LogLevel, type LogQuery, type LogRow } from './logs/data.ts';
import { inbox } from './inbox/data.ts';
import { instanceMessages } from './integration/messages.ts';
import { runList } from './runs/data.ts';
import { outputFiles } from '../engine/runs/output-files.ts';
import { settings, SettingsOp, applySettings } from './settings/data.ts';
import { exposure } from '../engine/access/exposure.ts';
import { StudioOp, studioView, type StudioPort } from './studio/model.ts';
import {
	audienceOf,
	canOpen,
	challengeOf,
	holdsPublic,
	kioskNav,
	startableAutomations,
	cookieNames,
	cookieSite,
	environmentLabel,
	nav,
	SHELL,
	surfaces,
	VISITOR_APP,
	type ShellBoot,
	type ShellNotice,
	type WorkspaceLink
} from './nav.ts';

const SESSION_S = 7 * 86_400,
	VISITOR_S = 30 * 86_400;
/** The service worker's source: it shows a pushed notice and opens its link. */
const WORKER = `self.addEventListener('push', (e) => {
	const n = e.data ? e.data.json() : {};
	e.waitUntil(self.registration.showNotification(n.title || '', { body: n.body || undefined, data: { url: new URL((n.path || '/inbox').replace(/^[/]/, ''), self.registration.scope).href } }));
});
self.addEventListener('notificationclick', (e) => {
	e.notification.close();
	e.waitUntil(self.clients.openWindow(e.notification.data.url));
});
`;

/** How a workspace signs people in (`GET /__bolt/session/methods`): by email, by mobile number, and who may sign up by which. */
export type SignInMethods = {
	email: boolean;
	phone: boolean;
	/** A number's code may also be sent over WhatsApp. */
	whatsapp: boolean;
	signup: readonly ('email' | 'phone')[];
	/** The workspace's locale: a mobile number's country defaults to its region. */
	locale: string;
};
export type TurnstileShape = {
	readonly siteKey: string | undefined;
	readonly verify: (token: string, ip: string) => Effect.Effect<boolean, Unavailable>;
};
export class Turnstile extends Context.Service<Turnstile, TurnstileShape>()('bolt/Turnstile') {
	static readonly dev = Layer.succeed(Turnstile, {
		siteKey: 'dev',
		verify: (token: string) => Effect.succeed(token === 'dev-pass')
	});
	static readonly unavailable = Layer.succeed(Turnstile, {
		siteKey: undefined,
		verify: () =>
			Effect.fail(
				new Unavailable({ facility: 'turnstile', reason: 'This host verifies no challenge.' })
			)
	});
	static readonly cloudflare = (siteKey: string, secret: Redacted.Redacted<string>) =>
		Layer.effect(
			Turnstile,
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				return {
					siteKey,
					verify: (token: string, ip: string) =>
						client
							.execute(
								HttpClientRequest.post(
									'https://challenges.cloudflare.com/turnstile/v0/siteverify'
								).pipe(
									HttpClientRequest.bodyUrlParams({
										secret: Redacted.value(secret),
										response: token,
										remoteip: ip
									})
								)
							)
							.pipe(
								Effect.flatMap(
									HttpClientResponse.schemaBodyJson(Schema.Struct({ success: Schema.Boolean }))
								),
								Effect.map((result) => result.success),
								Effect.timeout('10 seconds'),
								Effect.catch(() => Effect.succeed(false))
							)
				};
			})
		);
}
export type ShellHostConfig = {
	readonly publicUrl: string;
	readonly workspace: {
		readonly name: string;
		readonly handle: string;
		readonly icons?: readonly {
			readonly src: string;
			readonly sizes: string;
			readonly type: string;
		}[];
	};
	readonly push?: { readonly publicKey: string };
	readonly studio?: StudioPort;
	readonly secure?: boolean;
	readonly ai?: boolean;
	readonly environment?: string;
	readonly notice?: (auth: Authority) => Promise<ShellNotice | null>;
	readonly organization?: {
		write(auth: Authority, branding: { name: string; logo: string | null }): Promise<void>;
	};
	readonly apex?: string;
	/** Set when this shell serves a preview environment: the live workspace's address (the preview banner's link). */
	readonly live?: string;
	readonly workspaces?: (auth: Authority) => Promise<readonly WorkspaceLink[]>;
	/** The workspace log from the host's log store (the runtime log), asked only for an administrator; unset, `sys_event` answers. */
	readonly logs?: (query: LogQuery) => Promise<readonly LogRow[]>;
};
export class ShellConfig extends Context.Service<ShellConfig, ShellHostConfig>()(
	'bolt/ShellConfig'
) {}
export class HostIdentity extends Context.Service<HostIdentity, IdentityHost>()(
	'bolt/HostIdentity'
) {}
export type PublicPageRoute =
	| { readonly kind: 'app'; readonly app: string }
	| { readonly kind: 'kiosk'; readonly kiosk: string };
type BootState =
	| {
			readonly _tag: 'Ready';
			readonly boot: ShellBoot;
			readonly authority: Authority;
			readonly headers: Readonly<Record<string, string>>;
	  }
	| { readonly _tag: 'Refused'; readonly response: HttpServerResponse.HttpServerResponse };
type PublicPageCaller =
	| {
			readonly _tag: 'Ready';
			readonly boot: ShellBoot;
			readonly authority: Authority;
			readonly request: HttpServerRequest.HttpServerRequest;
			readonly headers: Readonly<Record<string, string>>;
			readonly base: string;
	  }
	| { readonly _tag: 'Refused'; readonly response: HttpServerResponse.HttpServerResponse };
export class ShellHandler extends Context.Service<
	ShellHandler,
	{
		readonly handle: Handler;
		readonly publicPage: (
			request: HttpServerRequest.HttpServerRequest,
			route: PublicPageRoute
		) => Effect.Effect<PublicPageCaller, EngineError>;
	}
>()('bolt/ShellHandler') {}
const Body = Schema.Record(Schema.String, Schema.Json);
const getHeader = (request: HttpServerRequest.HttpServerRequest, name: string) =>
	header(request, name) ?? null;
const ForeignFailure = Schema.Struct({
	_tag: Schema.Literal('HostFailure'),
	code: Schema.Literals(CODES),
	phase: Schema.Literals(PHASES),
	message: Schema.String
});
const hostCall = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (error) => {
			if (error instanceof BoltError) return error;
			const failure = Schema.decodeUnknownOption(ForeignFailure)(error);
			return Option.isSome(failure)
				? BoltError.make(failure.value.code, failure.value.phase, failure.value.message)
				: BoltError.make('upstream', 'facility', String(error));
		}
	});
type Caller = {
	authority: Authority | null;
	real: Authority | null;
	token: string | null;
	preview: ShellBoot['preview'];
	expiresAt?: number;
};
/** The preview cookie names a member id, or `team:<id>` (rule 39). */
const TEAM = 'team:';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	HttpServerResponse.jsonUnsafe(body, { status, headers });
/** A preview environment drops the meta tools (Norbius, Studio, who-has-access management); they refuse there. */
export const NOT_IN_PREVIEW = 'Not available in a preview.';
/** The Settings operations a preview keeps: everything else manages people, keys or Norbius. */
const PREVIEW_SETTINGS = new Set<SettingsOp['op']>(['setSecret', 'clearSecret']);
const refused = (code: string, message: string, status: number, retryAfter?: number) =>
	json(
		{ error: { code, message } },
		status,
		retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }
	);
const duplicateCredentials = (
	request: HttpServerRequest.HttpServerRequest,
	names: ReadonlySet<string>
): boolean => {
	const seen = new Set<string>();
	for (const part of (getHeader(request, 'cookie') ?? '').split(';')) {
		const at = part.indexOf('=');
		const name = part.slice(0, at).trim();
		if (at < 0 || !names.has(name)) continue;
		if (seen.has(name)) return true;
		seen.add(name);
	}
	return false;
};
/** Credentials have one canonical host-only name; duplicates are refused before caller resolution. */
function cookies(request: HttpServerRequest.HttpServerRequest): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of (getHeader(request, 'cookie') ?? '').split(';')) {
		const at = part.indexOf('='),
			name = part.slice(0, at).trim();
		if (at > 0 && !out.has(name)) {
			const value = Result.getOrUndefined(
				Result.try(() => decodeURIComponent(part.slice(at + 1).trim()))
			);
			if (value !== undefined) out.set(name, value);
		}
	}
	return out;
}
/** The request's canonical session token, or `null`. */
const sessionToken = (
	request: HttpServerRequest.HttpServerRequest,
	name: string
): string | null => {
	const token = cookies(request).get(name);
	return token === undefined || token === '' ? null : token;
};
/** The common shell boot; members and visitors only add their own data and host capabilities. */
const bootFor = (
	manifest: EngineManifest,
	workspace: ShellBoot['workspace'],
	authority: Authority,
	studio = false
): ShellBoot => ({
	workspace,
	actor: authority.actor,
	name: null,
	admin: authority.admin,
	preview: null,
	nav: nav(manifest, authority),
	kiosks: kioskNav(manifest, authority),
	startable: startableAutomations(manifest, authority),
	surfaces: surfaces(
		manifest,
		authority.actor,
		authority.admin,
		studio,
		workspace.live !== undefined
	),
	inbox: 0,
	push: null,
	visitor: null,
	catalog: exposure(manifest, authority),
	contract: fingerprint(schemaSlice(manifest))
});
const makeShell = Effect.gen(function* () {
	const c = yield* ShellConfig,
		h = yield* HostIdentity,
		m = yield* Manifest,
		identity = yield* Identity,
		db = yield* TenantDb,
		runs = yield* Runs,
		secrets = yield* Secrets,
		turnstile = yield* Turnstile,
		rateLimits = yield* RateLimits;
	const authorities = new Authorities(m, (yield* Activation).release);

	h.events = {
		manifest: m,
		announce: h.now.pipe(Effect.flatMap((now) => runs.nudge(now.toISOString())))
	};
	const secure = c.secure ?? true;
	const names = cookieNames(secure);
	const credentialNames: ReadonlySet<string> = new Set(Object.values(names));
	const crypto = yield* Crypto.Crypto;
	const uuid = crypto.randomUUIDv4.pipe(
		Effect.mapError((error) =>
			BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
		)
	);
	const cookie = (name: string, value: string, maxAge: number | null) =>
		`${name}=${encodeURIComponent(value)}; Path=${basePath(c.publicUrl) || '/'}; HttpOnly; ${cookieSite(secure)}${maxAge === null ? '' : `; Max-Age=${maxAge}`}`;
	const publicApp = (name: string | null): string | null =>
		name !== null && audienceOf(m.apps[name]) === 'public' ? name : null;
	const queryScopedRequest = Effect.fn('shell.queryScopedRequest')(function* (
		request: HttpServerRequest.HttpServerRequest
	) {
		const url = requestUrl(request);
		const file =
			(request.method === 'GET' || request.method === 'HEAD') &&
			url.pathname.startsWith(PATHS.files);
		const live = request.method === 'GET' && url.pathname === PATHS.live;
		if (!file && !live) return request;
		const apps = file ? url.searchParams.getAll('app') : [];
		const kiosks = url.searchParams.getAll('kiosk');
		if (apps.length > 1 || kiosks.length > 1 || (apps.length !== 0 && kiosks.length !== 0))
			return yield* Effect.fail(
				invalid('A public file or kiosk stream must name one unambiguous surface.')
			);
		const app = apps[0];
		const kiosk = kiosks[0];
		const headerApp = getHeader(request, VISITOR_APP);
		const headerKiosk = getHeader(request, HEADERS.kiosk);
		if (
			(app !== undefined && ((headerApp !== null && headerApp !== app) || headerKiosk !== null)) ||
			(kiosk !== undefined &&
				((headerKiosk !== null && headerKiosk !== kiosk) ||
					headerApp !== null ||
					(live && url.searchParams.has('app'))))
		)
			return yield* Effect.fail(invalid('Public surface headers and query parameters disagree.'));
		if (app !== undefined) {
			if (publicApp(app) === null)
				return yield* Effect.fail(
					BoltError.make('forbidden', 'admission', 'This public app is not declared.')
				);
			return request.modify({ headers: Headers.set(request.headers, VISITOR_APP, app) });
		}
		if (kiosk !== undefined) {
			const spec = m.kiosks?.[kiosk];
			if (
				!/^[a-z][a-z0-9_]*$/.test(kiosk) ||
				spec === undefined ||
				(file && (spec.auth ?? 'members') === 'members')
			)
				return yield* Effect.fail(
					BoltError.make('forbidden', 'admission', 'This public kiosk is not declared.')
				);
			return request.modify({ headers: Headers.set(request.headers, HEADERS.kiosk, kiosk) });
		}
		return request;
	});

	/** The session the request's cookie names, or `null`. */
	const signedIn = Effect.fn('shell.signedIn')(function* (
		request: HttpServerRequest.HttpServerRequest
	) {
		const token = sessionToken(request, names.session);
		if (token === null) return null;
		const s = yield* authenticate(h, token).pipe(
			Effect.catchTag('IdentityRefusal', () => Effect.succeed(null))
		);
		return s === null ? null : { token, ...s };
	});
	const resolveCaller = Effect.fn('shell.caller')(function* (
		request: HttpServerRequest.HttpServerRequest
	): Effect.fn.Return<Caller, EngineError> {
		const scoped = yield* queryScopedRequest(request);
		const x = yield* baseCaller(scoped);
		const url = requestUrl(scoped);
		const kiosk = Option.getOrNull(
			requestKiosk(scoped, url.pathname === PATHS.live && scoped.method === 'GET')
		);
		if (kiosk === null) return x;
		const me = x.authority !== null && x.authority.actor.kind === 'member' ? x.authority : null;
		const authority = Option.getOrNull(
			yield* kioskAuthority(m, kiosk, me, cookies(scoped).get(names.visitor) ?? (yield* uuid)).pipe(
				Effect.provideService(Identity, identity)
			)
		);
		if (authority === null)
			return yield* Effect.fail(
				BoltError.make('forbidden', 'admission', `no kiosk '${kiosk}' is open to this caller`)
			);
		return { ...x, authority };
	});
	const baseCaller = Effect.fn('shell.baseCaller')(function* (
		request: HttpServerRequest.HttpServerRequest
	): Effect.fn.Return<Caller, EngineError> {
		if (duplicateCredentials(request, credentialNames))
			return yield* Effect.fail(
				BoltError.make('invalid', 'admission', 'Duplicate credentials are refused.')
			);
		const jar = cookies(request);
		const app = publicApp(getHeader(request, VISITOR_APP));
		// rule 38d: a visitor page's request runs as that app's visitor, signed in or not — unless the member signed in holds a
		// policy naming that app (a customer who verified their number on the portal): they run as themselves
		if (app !== null) {
			const s = yield* signedIn(request);
			const me = s === null ? null : yield* authorities.member(h.db, s.user);
			if (s !== null && me !== null && holdsPublic(me, app))
				return { authority: me, real: me, token: s.token, preview: null, expiresAt: s.expiresAt };
			return {
				authority: authorities.visitor(app, jar.get(names.visitor) ?? (yield* uuid)),
				real: null,
				token: null,
				preview: null
			};
		}
		const bearer = /^Bearer (nbk_\S+)$/.exec(getHeader(request, 'authorization') ?? '')?.[1];
		if (bearer !== undefined) {
			const key = yield* authenticateKey(h, bearer);
			const a = key === null ? null : yield* authorities.apiKey(h.db, key);
			return { authority: a, real: a, token: null, preview: null };
		}
		const s = yield* signedIn(request),
			token = s?.token ?? null;
		const expiresAt = s === null ? {} : { expiresAt: s.expiresAt };
		const real = s === null ? null : yield* authorities.member(h.db, s.user);
		const target = jar.get(names.preview);
		if (real !== null && target !== undefined && real.admin) {
			{
				const team = target.startsWith(TEAM) ? target.slice(TEAM.length) : null;
				const p = yield* previewAs(real, authorities, h.db, team === null ? target : { team }).pipe(
					Effect.catchTag('BoltError', (error) =>
						error.code === 'forbidden' || error.code === 'notFound'
							? Effect.succeed(null)
							: Effect.fail(error)
					)
				);
				if (p === null) return { authority: real, real, token, preview: null, ...expiresAt };
				return {
					authority: p.authority,
					real,
					token,
					preview:
						team === null ? { user: target, by: p.impersonatedBy } : { team, by: p.impersonatedBy },
					...expiresAt
				};
			}
		}
		return { authority: real, real, token, preview: null, ...expiresAt };
	});
	const callers = new WeakMap<
		HttpServerRequest.HttpServerRequest,
		Effect.Effect<Caller, EngineError>
	>();
	const caller = (request: HttpServerRequest.HttpServerRequest) =>
		Effect.gen(function* () {
			let value = callers.get(request);
			if (value === undefined) {
				value = yield* Effect.cached(resolveCaller(request));
				callers.set(request, value);
			}
			return yield* value;
		});
	/** Rule 38d (a, b): per-IP limits, then the Turnstile token, both before decode; only `read`/`get` and generated `create`. */
	const visitorGate = Effect.fn('shell.visitorGate')(function* (
		request: HttpServerRequest.HttpServerRequest,
		auth: Authority,
		path: string
	) {
		if (auth.actor.kind !== 'visitor') return null;
		const ip = Option.getOrElse(request.remoteAddress, () => '0.0.0.0'),
			app = auth.actor.app;
		const charge = Effect.fn('shell.visitorCharge')(function* (kind: RateKind) {
			const verdict = yield* rateLimits.charge(
				chargesFor(auth, [kind], { ip: macKey(h.keys.ipMac, addressBucket(ip)) }),
				yield* Clock.currentTimeMillis
			);
			return verdict.ok ? null : refused('rateLimited', 'rateLimited', 429, verdict.retryAfter);
		});
		const challenge = Effect.gen(function* () {
			if (challengeOf(m, app) === undefined) return null;
			const token = getHeader(request, HEADERS.challenge);
			if (turnstile.siteKey === undefined)
				return refused('unavailable', 'This host verifies no challenge.', 503);
			return token !== null && token !== '' && (yield* turnstile.verify(token, ip))
				? null
				: refused('forbidden', 'forbidden', 403);
		});
		const forbidden = refused('forbidden', 'Visitors may not do this.', 403);
		if (auth.kiosk !== undefined && path === PATHS.live) return yield* charge('read');
		if (path === PATHS.q && request.method === 'POST') {
			const verdict = yield* requestReadRate(request, auth).pipe(
				Effect.provideService(RateLimits, rateLimits)
			);
			if (!verdict.ok) return refused('rateLimited', 'rateLimited', 429, verdict.retryAfter);
			const body = yield* requestBody(request, QBody);
			return body.reads.every((read) =>
				readAdmitted(auth, { kind: read.m, collection: String(read.a[0]) })
			)
				? null
				: forbidden;
		}
		if (path === PATHS.act && request.method === 'POST') {
			const admission = yield* requestActRate(request, auth).pipe(
				Effect.provideService(RateLimits, rateLimits)
			);
			const limited = admission.verdict.ok
				? null
				: refused('rateLimited', 'rateLimited', 429, admission.verdict.retryAfter);
			const checked = limited ?? (yield* challenge);
			if (checked !== null) return checked;
			const body = yield* requestBody(request, ActBody),
				dot = body.callable.lastIndexOf('.');
			return dot > 0 &&
				admitVisitor(auth, {
					act: body.callable.slice(0, dot),
					verb: body.callable.slice(dot + 1)
				}) === null
				? null
				: forbidden;
		}
		if (path.startsWith(PATHS.files) && request.method === 'PUT') {
			const limited = yield* charge('upload');
			return limited ?? (yield* challenge);
		}
		if (path.startsWith(PATHS.files) && (request.method === 'GET' || request.method === 'HEAD'))
			return null;
		return forbidden;
	});
	const ready = (
		boot: ShellBoot,
		authority: Authority,
		headers: Readonly<Record<string, string>> = {}
	): BootState => ({ _tag: 'Ready', boot, authority, headers });
	const rejected = (
		response: HttpServerResponse.HttpServerResponse
	): Extract<BootState, { readonly _tag: 'Refused' }> => ({ _tag: 'Refused', response });
	const bootState = Effect.fn('shell.bootState')(function* (
		request: HttpServerRequest.HttpServerRequest,
		x: Caller
	): Effect.fn.Return<BootState, EngineError> {
		const url = requestUrl(request);
		const app = publicApp(url.searchParams.get('app'));
		const logo = c.workspace.icons?.[0]?.src;
		const env = environmentLabel(c.environment);
		const ws: ShellBoot['workspace'] = {
			name: c.workspace.name,
			handle: c.workspace.handle,
			locale: m.workspace.locale,
			tz: m.workspace.tz,
			...(logo === undefined ? {} : { logo }),
			...(env === null ? {} : { environment: env }),
			...(c.apex === undefined ? {} : { apex: c.apex }),
			...(c.live === undefined ? {} : { live: c.live }),
			...(c.organization === undefined ? {} : { organization: true as const })
		};
		// a kiosk boot names its kiosk: signed-out callers boot only `auth: 'none'` kiosks (no sign-in, the
		// requests run as the assigned policies); members boot any kiosk they may open, with the boot catalog
		// cut to what the kiosk may read. Anything else is unauthenticated (signed-out) or forbidden.
		const kioskName = Option.getOrNull(requestKiosk(request, true));
		if (kioskName !== null) {
			const jar = cookies(request),
				id = jar.get(names.visitor) ?? (yield* uuid);
			const meAuth = x.authority?.actor.kind === 'member' ? x.authority : null;
			const opened = yield* kioskBoot(m, kioskName, meAuth, id).pipe(
				Effect.provideService(Identity, identity)
			);
			if (opened._tag === 'Unknown') return rejected(refused('notFound', 'No such kiosk.', 404));
			if (opened._tag === 'SignIn')
				return rejected(
					json(
						{ error: { code: 'unauthenticated', message: 'Sign in first.', workspace: ws } },
						401
					)
				);
			if (opened._tag === 'Closed') return rejected(refused('forbidden', opened.message, 403));
			const actor = x.authority?.actor;
			const me =
				x.authority !== null && actor !== undefined && actor.kind === 'member'
					? { auth: x.authority, actor }
					: null;
			if (me !== null) {
				const kioskAuth = opened.authority;
				const b = {
					...bootFor(m, ws, me.auth, c.studio !== undefined),
					name:
						Option.getOrNull(
							yield* db.one(Schema.Struct({ name: Schema.NullOr(Schema.String) }), {
								text: 'SELECT name FROM sys_user WHERE id = $1',
								params: [me.actor.id]
							})
						)?.name ?? null,
					preview: x.preview,
					catalog: exposure(m, kioskAuth)
				};
				return ready(b, kioskAuth);
			}
			const auth = opened.authority;
			const b = { ...bootFor(m, ws, auth), nav: [], visitor: { app: kioskName } };
			return ready(
				b,
				auth,
				jar.has(names.visitor) ? {} : { 'set-cookie': cookie(names.visitor, id, VISITOR_S) }
			);
		}
		// a visitor page (unless the member signed in holds it): the visitor cookie is minted when absent, and the page sees only its own app
		if (app !== null && !(x.authority !== null && holdsPublic(x.authority, app))) {
			const jar = cookies(request),
				id = jar.get(names.visitor) ?? (yield* uuid);
			const auth = authorities.visitor(app, id);
			const siteKey = challengeOf(m, app) === undefined ? undefined : turnstile?.siteKey;
			const b = {
				...bootFor(m, ws, auth),
				visitor: { app, ...(siteKey === undefined ? {} : { siteKey }) }
			};
			return ready(
				b,
				auth,
				jar.has(names.visitor) ? {} : { 'set-cookie': cookie(names.visitor, id, VISITOR_S) }
			);
		}
		const auth = x.authority;
		// the access pages name the workspace (and its environment) to a signed-out caller
		if (auth === null || auth.actor.kind !== 'member')
			return rejected(
				json({ error: { code: 'unauthenticated', message: 'Sign in first.', workspace: ws } }, 401)
			);
		const user = yield* db.one(Schema.Struct({ name: Schema.NullOr(Schema.String) }), {
			text: 'SELECT name FROM sys_user WHERE id = $1',
			params: [auth.actor.id]
		});
		const s = surfaces(m, auth.actor, auth.admin, c.studio !== undefined, c.live !== undefined);
		const box = s.inbox ? yield* inbox(h.db, auth) : null;
		const noticePort = c.notice;
		const notice = noticePort === undefined ? null : yield* hostCall(() => noticePort(auth));
		// never while previewing: the switcher would carry the previewed member's workspaces
		const workspacePort = c.workspaces;
		const workspaces =
			x.preview === null && workspacePort !== undefined
				? yield* hostCall(() => workspacePort(auth))
				: [];
		const b: ShellBoot = {
			...bootFor(m, ws, auth, c.studio !== undefined),
			name: Option.getOrNull(user)?.name ?? null,
			preview: x.preview,
			surfaces: s,
			inbox: box === null ? 0 : box.requests.filter((r) => r.canDecide).length + box.unread,
			push: s.inbox ? (c.push?.publicKey ?? null) : null,
			...(c.ai === false ? { aiUnconfigured: true as const } : {}),
			...(notice === null ? {} : { notice }),
			...(workspaces.length === 0 ? {} : { workspaces }),
			envoys: Object.fromEntries(Object.entries(m.envoys).map(([key, envoy]) => [key, envoy.name]))
		};
		// the session slides in the database (a day at most between refreshes); every boot carries it to the cookie too, so a
		// member who keeps coming back is never signed out by a cookie that kept its first seven days
		const left =
			x.token === null || x.expiresAt === undefined
				? 0
				: Math.floor((x.expiresAt - (yield* h.now).getTime()) / 1000);
		return ready(
			b,
			auth,
			left > 0 && x.token !== null ? { 'set-cookie': cookie(names.session, x.token, left) } : {}
		);
	});
	const boot = (request: HttpServerRequest.HttpServerRequest, x: Caller) =>
		bootState(request, x).pipe(
			Effect.map((state) =>
				state._tag === 'Refused'
					? state.response
					: json({ value: state.boot }, 200, { ...state.headers })
			)
		);
	const publicPage = Effect.fn('shell.publicPage')(function* (
		request: HttpServerRequest.HttpServerRequest,
		target: PublicPageRoute
	): Effect.fn.Return<PublicPageCaller, EngineError> {
		if (duplicateCredentials(request, credentialNames))
			return rejected(refused('invalid', 'Duplicate credentials are refused.', 400));
		const jar = cookies(request);
		const id = jar.get(names.visitor) ?? (yield* uuid);
		const url = requestUrl(request);
		url.searchParams.delete('app');
		url.searchParams.delete('kiosk');
		url.searchParams.set(
			target.kind === 'app' ? 'app' : 'kiosk',
			target.kind === 'app' ? target.app : target.kiosk
		);
		let headers = Headers.remove(Headers.remove(request.headers, VISITOR_APP), HEADERS.kiosk);
		if (target.kind === 'app') headers = Headers.set(headers, VISITOR_APP, target.app);
		if (!jar.has(names.visitor))
			headers = Headers.set(
				headers,
				'cookie',
				[getHeader(request, 'cookie'), `${names.visitor}=${encodeURIComponent(id)}`]
					.filter((value) => value !== null && value !== '')
					.join('; ')
			);
		const selected = request.modify({ url: url.pathname + url.search, headers });
		const state = yield* bootState(selected, yield* baseCaller(selected));
		if (state._tag === 'Refused') return state;
		if (target.kind === 'app' && !canOpen(m, state.authority, target.app))
			return rejected(refused('forbidden', 'This page is not open to you.', 403));
		return {
			...state,
			request: selected,
			base: new URL(c.publicUrl).pathname.replace(/\/$/, ''),
			headers: {
				...state.headers,
				...(!jar.has(names.visitor) && state.authority.actor.kind === 'visitor'
					? { 'set-cookie': cookie(names.visitor, id, VISITOR_S) }
					: {})
			}
		};
	});
	const sessionRoutes: Readonly<
		Record<
			string,
			(
				request: HttpServerRequest.HttpServerRequest,
				current: Effect.Effect<Caller, EngineError>
			) => Effect.Effect<HttpServerResponse.HttpServerResponse, EngineError>
		>
	> = {
		[`GET ${PATHS.session.methods}`]: () =>
			Effect.gen(function* () {
				const [config] = yield* h.db.read([
					{ text: `SELECT value FROM sys_config WHERE key = '${SIGNUP_KEY}'`, params: [] }
				]);
				const open = h.signup !== undefined && config?.rows[0]?.value !== 'closed',
					phone = h.phone !== undefined;
				const methods: SignInMethods = {
					email: h.mail !== undefined,
					phone,
					whatsapp: h.phone?.via.includes('whatsapp') === true,
					locale: m.workspace.locale,
					signup:
						open && h.signup !== undefined
							? h.signup.via.filter((via) => (via === 'email' ? h.mail !== undefined : phone))
							: []
				};
				return json({ value: methods });
			}),
		[`POST ${PATHS.session.code}`]: (request) =>
			Effect.gen(function* () {
				const body = yield* requestBody(request, SessionCode);
				yield* sendCode(
					h,
					body.address,
					Option.getOrElse(request.remoteAddress, () => '0.0.0.0'),
					body.via === 'whatsapp' ? 'whatsapp' : 'sms'
				);
				return json({ value: null });
			}),
		[`POST ${PATHS.session.verify}`]: (request) =>
			Effect.gen(function* () {
				const body = yield* requestBody(
					request,
					Schema.Struct({ address: Schema.String, code: Schema.String })
				);
				const session = yield* verifyCode(
					h,
					body.address,
					body.code,
					Option.getOrElse(request.remoteAddress, () => '0.0.0.0')
				);
				return json({ value: { user: session.user } }, 200, {
					'set-cookie': cookie(names.session, session.token, SESSION_S)
				});
			}),
		[`POST ${PATHS.session.signout}`]: (request) =>
			Effect.gen(function* () {
				const token = sessionToken(request, names.session);
				if (token !== null) {
					yield* h.db.write({
						text: 'DELETE FROM sys_session WHERE token_hash = $1',
						params: [sha256(token)]
					});
					yield* forget(h, token);
				}
				return HttpServerResponse.empty({ status: 204 }).pipe(
					HttpServerResponse.setCookiesUnsafe([
						[
							names.session,
							'',
							{
								path: basePath(c.publicUrl) || '/',
								httpOnly: true,
								secure,
								partitioned: secure,
								sameSite: secure ? 'none' : 'lax',
								maxAge: 0
							}
						],
						[
							names.preview,
							'',
							{
								path: basePath(c.publicUrl) || '/',
								httpOnly: true,
								secure,
								partitioned: secure,
								sameSite: secure ? 'none' : 'lax',
								maxAge: 0
							}
						]
					])
				);
			}),
		[`GET ${PATHS.session.invitation}/:id`]: (request) =>
			Effect.gen(function* () {
				const id = yield* Effect.try({
					try: () =>
						decodeURIComponent(
							requestUrl(request).pathname.slice(PATHS.session.invitation.length + 1)
						),
					catch: () => invalid('Malformed invitation path.')
				});
				const view = yield* inspectInvitation(h, id);
				return view === null
					? refused('notFound', 'No such invitation.', 404)
					: json({ value: view });
			}),
		[`POST ${PATHS.session.invitation}`]: (request, current) =>
			Effect.gen(function* () {
				const body = yield* requestBody(request, Body),
					caller = yield* current;
				if (caller.real?.actor.kind !== 'member')
					return refused('unauthenticated', 'Sign in first.', 401);
				if (typeof body['id'] !== 'string')
					return yield* Effect.fail(invalid('The body is { id }.'));
				return json({
					value: yield* acceptInvitation(h, { user: caller.real.actor.id }, body['id'])
				});
			})
	};
	const session = (
		request: HttpServerRequest.HttpServerRequest,
		path: string,
		current: Effect.Effect<Caller, EngineError>
	) => {
		const key =
			request.method === 'GET' && path.startsWith(`${PATHS.session.invitation}/`)
				? `GET ${PATHS.session.invitation}/:id`
				: `${request.method} ${path}`;
		const route = sessionRoutes[key];
		return route === undefined ? Effect.succeed(null) : route(request, current);
	};
	const shell = Effect.fn('shell.shell')(function* (
		request: HttpServerRequest.HttpServerRequest,
		path: string,
		x: Caller
	) {
		if (path === SHELL && request.method === 'GET') return yield* boot(request, x);
		const auth = x.authority;
		if (auth === null || auth.actor.kind !== 'member')
			return refused('unauthenticated', 'Sign in first.', 401);
		const url = requestUrl(request);
		const s = surfaces(m, auth.actor, auth.admin, c.studio !== undefined, c.live !== undefined);
		switch (`${request.method} ${path.slice(SHELL.length)}`) {
			case 'GET /inbox':
				return s.inbox
					? json({ value: yield* inbox(h.db, auth) })
					: refused('forbidden', 'No inbox for this member.', 403);
			case 'GET /runs': {
				// rule 56: the Runs surface is staff's; a holder of an automation (external included) reads its runs through `bolt.runs`
				const one = url.searchParams.get('automation') ?? undefined;
				if (
					!s.runs &&
					!(one !== undefined && auth.automations.includes(one)) &&
					url.searchParams.get('id') === null
				)
					return refused('forbidden', 'No runs for this member.', 403);
				const id = url.searchParams.get('id');
				if (id === null)
					return json({
						value: yield* runList(
							h.db,
							auth,
							Number(url.searchParams.get('limit') ?? 100) || 100,
							one
						)
					});
				const run = yield* runs.view(auth, id).pipe(Effect.map(Option.getOrNull));
				return run === null
					? refused('notFound', 'Not found or no access.', 404)
					: json({
							value: {
								...run,
								...(run.result === undefined
									? {}
									: {
											files: outputFiles(
												m.automations[run.automation]?.output,
												run.result,
												m.customFields
											)
										})
							}
						});
			}
			case 'POST /runs/stop': {
				// hook:runtime — rule 56: whoever reads the run in full may stop it
				const id = (yield* requestBody(request, Body))['id'];
				const run =
					typeof id === 'string'
						? yield* runs.stop(auth, id).pipe(Effect.map(Option.getOrNull))
						: null;
				return run === null
					? refused('notFound', 'Not found or no access.', 404)
					: json({ value: run });
			}
			case 'GET /instance-messages': {
				const p = url.searchParams;
				return json({
					value: yield* instanceMessages(
						h.db,
						auth,
						p.get('instance') ?? '',
						p.get('before') ?? undefined
					)
				});
			}
			case 'GET /settings':
				return json({ value: yield* settings(h, m, auth, secrets) });
			case 'POST /settings':
				if (!auth.admin)
					return yield* Effect.fail(
						BoltError.make('forbidden', 'admission', 'Only administrators manage settings.')
					);
				const op = yield* requestBody(request, SettingsOp);
				if (c.live !== undefined && !PREVIEW_SETTINGS.has(op.op))
					return refused('forbidden', NOT_IN_PREVIEW, 403);
				return json({ value: yield* applySettings(h, m, auth, op, secrets) });
			case 'POST /organization': {
				// L-COL-199: the workspace's name and logo, an administrator's (never a previewed member's)
				if (c.organization === undefined)
					return refused(
						'unavailable',
						'This host keeps the branding in the workspace source.',
						503
					);
				if (!auth.admin)
					return refused('forbidden', 'Only an administrator edits the organization.', 403);
				const b = yield* requestBody(request, Body),
					logo = b['logo'] ?? null;
				if (
					typeof b['name'] !== 'string' ||
					b['name'].trim() === '' ||
					(logo !== null && typeof logo !== 'string')
				)
					return yield* Effect.fail(
						BoltError.make('invalid', 'decode', 'the body is { name, logo: string | null }')
					);
				const organization = c.organization,
					branding = { name: b['name'].trim(), logo };
				yield* hostCall(() => organization.write(auth, branding));
				return json({ value: null });
			}
			case 'GET /logs': {
				const p = url.searchParams,
					level = p.get('level'),
					conversation = p.get('conversation'),
					text = p.get('q'),
					given = (key: 'before' | 'after' | 'run' | 'automation' | 'since' | 'until') => {
						const v = p.get(key);
						return v === null ? {} : { [key]: v };
					};
				const query: LogQuery = {
						...given('before'),
						...given('after'),
						...given('run'),
						...given('automation'),
						...given('since'),
						...given('until'),
						...(level === 'info' || level === 'warn' || level === 'error' ? { level } : {}),
						...(text === null ? {} : { text }),
						...(conversation === null ? {} : { conversation })
					},
					logs = c.logs;
				if (logs === undefined) return json({ value: yield* events(h.db, auth, query) });
				const refusal = requireAdmin(auth);
				if (refusal !== null) return yield* Effect.fail(refusal);
				return json({ value: yield* hostCall(() => logs(query)) });
			}
			case 'GET /studio':
			case 'POST /studio': {
				if (!s.studio || c.studio === undefined)
					return refused('forbidden', 'Studio is for staff members on a host that serves it.', 403);
				const studio = c.studio;
				if (request.method === 'GET')
					return json({ value: studioView(yield* hostCall(() => studio.state(auth))) });
				const op = Schema.decodeUnknownOption(StudioOp)(
					(yield* requestBody(request, Body))['op'] ?? null
				);
				if (Option.isNone(op)) return refused('check', 'The Studio operation is malformed.', 422);
				return json({ value: studioView(yield* hostCall(() => studio.run(auth, op.value))) });
			}
			case 'GET /studio/build': {
				const read = c.studio?.build?.bind(c.studio),
					commit = url.searchParams.get('commit');
				if (!s.studio || read === undefined)
					return refused('forbidden', 'Studio is for staff members on a host that serves it.', 403);
				if (commit === null || commit === '') return refused('check', 'Give commit.', 422);
				return json({ value: yield* hostCall(() => read(auth, commit)) });
			}
			case 'GET /studio/usage': {
				const read = c.studio?.usage?.bind(c.studio);
				if (!s.studio || read === undefined || !auth.admin)
					return refused('forbidden', 'Usage is for administrators on a host that meters it.', 403);
				return json({ value: yield* hostCall(() => read(auth)) });
			}
			case 'GET /studio/events': {
				// pushed authoring frames (build log lines, a moved head); nothing is polled
				const watch = c.studio?.watch?.bind(c.studio);
				if (!s.studio || watch === undefined)
					return refused(
						'forbidden',
						'Studio is for staff members on a host that streams it.',
						403
					);
				return sseResponse(
					Stream.callback<import('./studio/model.ts').StudioFrame>((queue) =>
						Effect.acquireRelease(
							Effect.sync(() => watch(auth, (frame) => Queue.offerUnsafe(queue, frame))),
							(off) => Effect.sync(off)
						)
					)
				);
			}
			case 'POST /preview': {
				// rule 39: only the real administrator may start or end a preview, of a member or a team; a preview
				// environment has no preview-as (impersonation is access management, the live workspace's)
				if (c.live !== undefined) return refused('forbidden', NOT_IN_PREVIEW, 403);
				const b = yield* requestBody(request, Body),
					user = b['user'],
					team = b['team'];
				if (x.real === null || !x.real.admin)
					return refused(
						'forbidden',
						'Only an administrator can preview as a member or team.',
						403
					);
				if (user === null || team === null)
					return HttpServerResponse.empty({
						status: 204,
						headers: { 'set-cookie': cookie(names.preview, '', 0) }
					});
				if (typeof team === 'string') {
					yield* previewAs(x.real, authorities, h.db, { team });
					return HttpServerResponse.empty({
						status: 204,
						headers: { 'set-cookie': cookie(names.preview, `${TEAM}${team}`, null) }
					});
				}
				if (typeof user !== 'string')
					return yield* Effect.fail(
						BoltError.make('invalid', 'decode', 'the body is { user } or { team }')
					);
				yield* previewAs(x.real, authorities, h.db, user);
				return HttpServerResponse.empty({
					status: 204,
					headers: { 'set-cookie': cookie(names.preview, user, null) }
				});
			}
			case 'GET /explain': {
				// `access.explain` (L-BOLT-234): the caller's own Authority, or (administrators) a member's or team's as a preview compiles it
				const user = url.searchParams.get('user'),
					team = url.searchParams.get('team');
				let a: Authority = auth;
				if (user !== null || team !== null) {
					if (x.real === null || !x.real.admin)
						return refused(
							'forbidden',
							'Only an administrator can explain another member or team.',
							403
						);
					a = (yield* previewAs(x.real, authorities, h.db, team !== null ? { team } : (user ?? '')))
						.authority;
				}
				const { key: _key, ...explained } = a;
				return json({ value: explained });
			}
		}
		return null;
	});
	/** `GET /manifest.webmanifest` (§5.10, L-BOLT-295): scope and start_url from the configured public origin, never `Host`. */
	function webmanifest(): HttpServerResponse.HttpServerResponse {
		const scope = under(h.publicUrl, '/');
		return HttpServerResponse.text(
			JSON.stringify({
				id: c.workspace.handle,
				name: c.workspace.name,
				short_name: c.workspace.name,
				scope,
				start_url: scope,
				display: 'standalone',
				icons: c.workspace.icons ?? []
			}),
			{ headers: { 'content-type': 'application/manifest+json' } }
		);
	}

	const authority = (request: HttpServerRequest.HttpServerRequest) =>
		caller(request).pipe(
			Effect.map((x) => Option.fromNullishOr(x.authority)),
			Effect.mapError((e) =>
				e instanceof BoltError ? e : BoltError.make('internal', 'admission', String(e))
			)
		);
	const handle: Handler = (request) =>
		Effect.gen(function* () {
			const path = requestUrl(request).pathname;
			if (duplicateCredentials(request, credentialNames))
				return Option.some(refused('invalid', 'Duplicate credentials are refused.', 400));
			const origin = getHeader(request, 'origin'),
				site = getHeader(request, 'sec-fetch-site');
			if (
				!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
				(site === 'cross-site' ||
					site === 'same-site' ||
					(origin !== null && origin !== new URL(c.publicUrl).origin))
			)
				return Option.some(refused('forbidden', 'A write from another site is refused.', 403));
			if (path === '/manifest.webmanifest' && request.method === 'GET')
				return Option.some(webmanifest());
			if (path === SW && request.method === 'GET')
				return Option.some(
					HttpServerResponse.text(WORKER, {
						headers: {
							'content-type': 'text/javascript',
							'service-worker-allowed': `${basePath(h.publicUrl)}/`,
							'cache-control': 'no-cache'
						}
					})
				);
			const x = yield* Effect.cached(caller(request));
			if (path.startsWith(`${BOLT}/session/`))
				return Option.fromNullishOr(yield* session(request, path, x));
			if (!path.startsWith(`${BOLT}/`)) return Option.none();
			const current = yield* Effect.serviceOption(SessionAuthority);
			const selected = Option.isSome(current)
				? yield* current.value.of(request)
				: yield* authority(request);
			if (Option.isSome(selected) && selected.value.actor.kind === 'visitor')
				return Option.fromNullishOr(yield* visitorGate(request, selected.value, path));
			// Norbius belongs to the live workspace: a preview reads no transcript or models (its callables refuse in `BoltHostLive`)
			if (c.live !== undefined && (path === PATHS.agent || path.startsWith(`${PATHS.agent}/`)))
				return Option.some(refused('forbidden', NOT_IN_PREVIEW, 403));
			if (path === SHELL || path.startsWith(`${SHELL}/`))
				return Option.fromNullishOr(yield* shell(request, path, yield* x));
			return Option.none();
		}).pipe(
			Effect.catch((e) => Effect.succeed(Option.some(responseError(e)))),
			Effect.catchCause((cause) =>
				Effect.logWarning(cause).pipe(Effect.as(Option.some(responseError(cause))))
			)
		);
	return { authority, handle, publicPage };
});
export const authorityOf = (request: HttpServerRequest.HttpServerRequest) =>
	makeShell.pipe(
		Effect.flatMap((shell) => shell.authority(request)),
		Effect.map(Option.getOrNull)
	);
export const ShellRoutes = Layer.unwrap(
	makeShell.pipe(
		Effect.map((shell) =>
			Layer.mergeAll(
				Layer.succeed(ShellHandler, { handle: shell.handle, publicPage: shell.publicPage }),
				Layer.succeed(SessionAuthority, { of: shell.authority })
			)
		)
	)
);
