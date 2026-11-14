import { uuid } from '../engine/port.ts';
import { activeEnvoys } from '../engine/envoys/spec.ts';
// The shell's host half: the session routes (`/__bolt/session/*`), the
// caller's Authority for every data route (session cookie, API key, visitor, preview-as), the visitor gates in front
// of `/q`, `/act`, `/files` and `/live`, the shell's boot, inbox, runs and settings reads, and the PWA manifest.
// Native handlers answer their own routes and refusals, otherwise None; BoltHost composes them in the fixed order.
import {
	Clock,
	Context,
	Crypto,
	DateTime,
	Effect,
	Layer,
	Option,
	Queue,
	Result,
	Schema,
	Stream
} from 'effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Headers from 'effect/http/Headers';
import {
	AuditQuery,
	type Challenge,
	is_off,
	type LogQuery,
	type Off,
	type ShellNotice,
	type ShellPorts,
	StudioInspectInput,
	StudioOp,
	studio_view,
	Unavailable,
	type WorkspaceLink
} from '@norbital-ai/host-api';
import {
	Activation,
	Agents,
	Guest,
	Live,
	Manifest,
	Identity,
	HostIdentity,
	Runs,
	type Authenticated
} from '../engine/services.ts';
import { Syncs } from '../engine/sync/index.ts';
import { mayUpdate } from '../engine/write/act.ts';
import { TenantDb } from '../engine/db/tenant-db.ts';
import { Secrets } from '../engine/secrets.ts';
import { Logs } from '../engine/ports.ts';
import { RenderGrants } from '../engine/render.ts';
import {
	header,
	invalid,
	RateLimits,
	rateLimitedResponse,
	requestActRate,
	requestReadRate,
	wireReadAdmitted,
	requestBody,
	requestUrl,
	response_error,
	SessionAuthority
} from '../protocol/http.ts';
import { QBody, ActBody, SessionCode } from '../protocol/schema.ts';
import { sseResponse } from '../protocol/sse.ts';
import type { Handler } from '../protocol/host.ts';
import { requestKiosk, kioskAuthority, kioskBoot, KIOSK_PATH } from './public/kiosk.ts';
import type { EngineManifest } from '../engine/manifest.ts';
import type { Authority } from '../engine/contracts.ts';
import { type EngineError } from '../engine/errors.ts';
import { BoltError, CODES, PHASES } from '../protocol/errors.ts';
import { addressBucket, charges_for, macKey, type RateKind } from '../engine/access/rate.ts';
import { admit_visitor } from '../engine/callables/index.ts';
import { Authorities, preview_as } from '../engine/identity/actor.ts';
import {
	acceptInvitation,
	authenticateKey,
	inspectInvitation
} from '../engine/identity/members.ts';
import {
	authenticate,
	mergeAnonymous,
	mintAnonymous,
	requireAdmin,
	revokeSession,
	send_code,
	SIGNUP_KEY,
	verify_code,
	type IdentityHost,
	keysOf
} from '../engine/identity/session.ts';
import { BOLT, HEADERS, PATHS, SW, base_path, canonical_path, under } from '../protocol/wire.ts';
import { inbox } from './inbox/data.ts';
import { instance_messages } from './integration/messages.ts';
import { runList, visible_run_names } from '../engine/runs/rows.ts';
import { outputFiles } from '../engine/runs/output-files.ts';
import { settings, SettingsOp, applySettings, teamName } from './settings/data.ts';
import { exposure, read_catalog } from '../engine/access/exposure.ts';
import { client_contract, operation_output_catalog } from '../engine/access/operation-outputs.ts';
import { manifestItems } from './finder/manifest.ts';
import {
	audience_of,
	can_open,
	challenge_of,
	kiosk_of,
	holds_public,
	is_open_route,
	kiosk_nav,
	route,
	startable_automations,
	automation_inputs,
	cookie_names,
	cookie_site,
	environment_label,
	nav,
	SHELL,
	surfaces,
	VISITOR_APP,
	type ShellBoot
} from './nav.ts';
import { readLog, runLog } from '../engine/guest/telemetry.ts';
import { Audit } from '../engine/audit.ts';
import { audited, auditActor } from '../engine/audit-operation.ts';

import { canonical } from '@norbital-ai/store';
import { fromBase64, timingSafeEqual } from '../engine/crypto.ts';
import { PUSH_WORKER } from './push-worker.ts';

const SESSION_S = 7 * 86_400,
	VISITOR_S = 30 * 86_400;
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
type TurnstileShape = {
	readonly site_key: string | undefined;
	readonly verify: (token: string, ip: string) => Effect.Effect<boolean, Unavailable>;
};
export class Turnstile extends Context.Service<Turnstile, TurnstileShape>()('bolt/Turnstile') {
	static readonly dev = Layer.succeed(Turnstile, {
		site_key: 'dev',
		verify: (token: string) => Effect.succeed(token === 'dev-pass')
	});
	/** The host's challenge facility; `off` verifies none (a challenged app's visitors are refused). */
	static fromAbi(challenge: Challenge | Off): Layer.Layer<Turnstile> {
		return Layer.succeed(
			Turnstile,
			is_off(challenge)
				? {
						site_key: undefined,
						verify: () =>
							Effect.fail(
								new Unavailable({
									facility: 'turnstile',
									reason: 'This host verifies no challenge.'
								})
							)
					}
				: {
						site_key: challenge.site_key,
						verify: (token, ip) =>
							Effect.tryPromise((signal) => challenge.verify(token, ip, signal)).pipe(
								Effect.catch(() => Effect.succeed(false))
							)
					}
		);
	}
}
/** The shell's host parts (`HostPorts.shell`), and what the release sets beside them. */
export type ShellHostConfig = ShellPorts & {
	readonly public_url: string;
	readonly secure?: boolean;
	/** The release's client hash (`ShellBoot.client`). */
	readonly client?: string;
};
export class ShellConfig extends Context.Service<ShellConfig, ShellHostConfig>()(
	'bolt/ShellConfig'
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
const SyncReplay = Schema.Struct({
	instance: Schema.NonEmptyString,
	ids: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
});
const SyncRetire = Schema.Struct({ instance: Schema.NonEmptyString, id: Schema.NonEmptyString });
const RunId = Schema.Struct({ id: Schema.String });
/** L-COL-199: the workspace's logo (`null`, an `https:` URL or a `data:image/…` URL). */
const Branding = Schema.Struct({
	logo: Schema.optionalKey(Schema.NullOr(Schema.String))
});
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
/** The preview cookie names a member id, or `team:<id>`. */
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
): Effect.Effect<ShellBoot, BoltError> =>
	Effect.gen(function* () {
		return {
			workspace,
			actor: authority.actor,
			name: null,
			admin: authority.admin,
			preview: null,
			nav: nav(manifest, authority),
			kiosks: kiosk_nav(manifest, authority),
			startable: startable_automations(manifest, authority),
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
			catalog: yield* exposure(manifest, authority),
			read_catalog: yield* read_catalog(manifest, authority),
			automations: automation_inputs(manifest, authority),
			operation_outputs: operation_output_catalog(manifest, authority),
			search: manifestItems(manifest, authority, studio),
			contract: client_contract(manifest)
		};
	});
const makeShell = Effect.gen(function* () {
	const c = yield* ShellConfig,
		h = yield* HostIdentity,
		m = yield* Manifest,
		identity = yield* Identity,
		db = yield* TenantDb,
		guest = yield* Guest,
		runs = yield* Runs,
		live = yield* Live,
		syncs = yield* Syncs,
		secrets = yield* Secrets,
		turnstile = yield* Turnstile,
		rateLimits = yield* RateLimits,
		logs = yield* Logs,
		audit = yield* Audit,
		grants = yield* RenderGrants;
	const release = (yield* Activation).release;
	const authorities = new Authorities(m, release, { remember: true });
	// Run reader columns are immutable. A grant is usable only under the same release and current authority.
	const runLogAccess = (auth: Authority, id: string) => keysOf(h).pipe(
		Effect.map((keys) => macKey(keys.ipMac, `run-log:${canonical({ release, id, authority: auth })}`))
	);

	const secure = c.secure ?? true;
	const names = cookie_names(secure);
	const credentialNames: ReadonlySet<string> = new Set(Object.values(names));
	const crypto = yield* Crypto.Crypto;
	const newId = uuid(crypto);
	const cookie = (name: string, value: string, maxAge: number | null) =>
		`${name}=${encodeURIComponent(value)}; Path=${base_path(c.public_url) || '/'}; HttpOnly; ${cookie_site(secure)}${maxAge === null ? '' : `; Max-Age=${maxAge}`}`;
	const publicApp = (name: string | null): string | null =>
		name !== null && m.apps[name]?.shell !== 'kiosk' && audience_of(m.apps[name]) === 'public'
			? name
			: null;
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
			const spec = kiosk_of(m, kiosk);
			if (!KIOSK_PATH.test(kiosk) || spec === undefined || (file && audience_of(spec) === 'members'))
				return yield* Effect.fail(
					BoltError.make('forbidden', 'admission', 'This public kiosk is not declared.')
				);
			return request.modify({ headers: Headers.set(request.headers, HEADERS.kiosk, kiosk) });
		}
		return request;
	});

	/** A session minted for the agent's browser marks every authority it yields, a previewed one too (fail closed). */
	const marked = (s: Pick<Authenticated, 'agent'>, a: Authority): Authority =>
		s.agent === null ? a : { ...a, agent: s.agent };
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
	type Visitor = {
		readonly id: string;
		readonly anonymous: boolean;
		readonly token: string | null;
	};
	/** The visitor's anonymous user, whose session token the visitor cookie holds; without one, a per-request id. */
	const visitorOf = Effect.fn('shell.visitorOf')(function* (
		request: HttpServerRequest.HttpServerRequest
	) {
		const token = sessionToken(request, names.visitor);
		const s =
			token === null
				? null
				: yield* authenticate(h, token).pipe(
						Effect.catchTag('IdentityRefusal', () => Effect.succeed(null))
					);
		return s === null || token === null
			? ({ id: yield* newId, anonymous: false, token: null } satisfies Visitor)
			: ({ id: s.user, anonymous: true, token } satisfies Visitor);
	});
	/** Opening a public surface without an identity mints an anonymous user, at most `register` per IP; past it, none. */
	const mintVisitor = Effect.fn('shell.mintVisitor')(function* (
		request: HttpServerRequest.HttpServerRequest,
		auth: Authority
	) {
		const ip = yield* rateLimits.ipBucket(Option.getOrElse(request.remoteAddress, () => '0.0.0.0'));
		const verdict = yield* rateLimits.charge(
			charges_for(auth, ['register'], { ip }),
			yield* Clock.currentTimeMillis
		);
		if (!verdict.ok) return null;
		const minted = yield* mintAnonymous(h);
		return { id: minted.user, anonymous: true, token: minted.token } satisfies Visitor;
	});
	/** The visitor cookie follows the anonymous user's sliding session. */
	const visitorCookie = (v: Visitor): Record<string, string> =>
		v.token === null ? {} : { 'set-cookie': cookie(names.visitor, v.token, VISITOR_S) };
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
			yield* kioskAuthority(m, kiosk, me, yield* visitorOf(scoped)).pipe(
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
		// a visitor page's request runs as that app's visitor, signed in or not — unless the member signed in holds a
		// policy naming that app (a customer who verified their number on the portal): they run as themselves
		if (app !== null) {
			const s = yield* signedIn(request);
			const member = s === null ? null : yield* authorities.member(h.db, h.publication, s.user);
			const me = s === null || member === null ? null : marked(s, member);
			if (s !== null && me !== null && holds_public(me, app))
				return { authority: me, real: me, token: s.token, preview: null, expiresAt: s.expiresAt };
			const v = yield* visitorOf(request);
			return {
				authority: yield* authorities.visitor(app, v.id, v.anonymous),
				real: null,
				token: null,
				preview: null
			};
		}
		// a render grant (`ctx.convert.record`'s print) reads as its run, and only reads: GETs and the query route
		const printing = /^Bearer (nbr_\S+)$/.exec(getHeader(request, 'authorization') ?? '')?.[1];
		if (printing !== undefined) {
			const reads = request.method === 'GET' || requestUrl(request).pathname === PATHS.q;
			const a = reads ? (grants.of(printing) ?? null) : null;
			return { authority: a, real: a, token: null, preview: null };
		}
		const bearer = /^Bearer (nbk_\S+)$/.exec(getHeader(request, 'authorization') ?? '')?.[1];
		if (bearer !== undefined) {
			const key = yield* authenticateKey(h, bearer);
			const a = key === null ? null : yield* authorities.api_key(h.db, key);
			return { authority: a, real: a, token: null, preview: null };
		}
		const s = yield* signedIn(request),
			token = s?.token ?? null;
		const expiresAt = s === null ? {} : { expiresAt: s.expiresAt };
		const member = s === null ? null : yield* authorities.member(h.db, h.publication, s.user);
		const real = s === null || member === null ? null : marked(s, member);
		const target = jar.get(names.preview);
		if (real !== null && target !== undefined && real.admin) {
			{
				const team = target.startsWith(TEAM) ? target.slice(TEAM.length) : null;
				const p = yield* preview_as(real, authorities, h.db, h.publication, team === null ? target : { team }).pipe(
					Effect.catchTag('BoltError', (error) =>
						error.code === 'forbidden' || error.code === 'not_found'
							? Effect.succeed(null)
							: Effect.fail(error)
					)
				);
				if (p === null) return { authority: real, real, token, preview: null, ...expiresAt };
				return {
					authority: s === null ? p.authority : marked(s, p.authority),
					real,
					token,
					preview:
						team === null
							? { user: target, by: p.impersonatedBy }
							: { team, name: teamName(m, team), by: p.impersonatedBy },
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
				charges_for(auth, [kind], { ip: macKey((yield* keysOf(h)).ipMac, addressBucket(ip)) }),
				yield* Clock.currentTimeMillis
			);
			return verdict.ok ? null : rateLimitedResponse(verdict.retryAfter);
		});
		const challenge = Effect.gen(function* () {
			if (challenge_of(m, app) === undefined) return null;
			const token = getHeader(request, HEADERS.challenge);
			if (turnstile.site_key === undefined)
				return refused('unavailable', 'This host verifies no challenge.', 503);
			return token !== null && token !== '' && (yield* turnstile.verify(token, ip))
				? null
				: refused('forbidden', 'forbidden', 403);
		});
		const forbidden = refused('forbidden', 'Visitors may not do this.', 403);
		const read = Effect.gen(function* () {
			const verdict = yield* requestReadRate(request, auth).pipe(
				Effect.provideService(RateLimits, rateLimits)
			);
			return verdict.ok ? null : rateLimitedResponse(verdict.retryAfter);
		});
		if (auth.kiosk !== undefined && path === PATHS.live) return yield* read;
		if (path === PATHS.q && request.method === 'POST') {
			const limited = yield* read;
			if (limited !== null) return limited;
			const body = yield* requestBody(request, QBody);
			return body.reads.every((read) => wireReadAdmitted(auth, read)) ? null : forbidden;
		}
		if (path === PATHS.act && request.method === 'POST') {
			const admission = yield* requestActRate(request, auth).pipe(
				Effect.provideService(RateLimits, rateLimits)
			);
			const limited = admission.verdict.ok
				? null
				: rateLimitedResponse(admission.verdict.retryAfter);
			const checked = limited ?? (yield* challenge);
			if (checked !== null) return checked;
			const body = yield* requestBody(request, ActBody);
			if (!('acts' in body)) return forbidden;
			return Object.keys(body.acts).every((callable) => {
				const dot = callable.lastIndexOf('.');
				return dot > 0 && admit_visitor(auth, { act: callable.slice(0, dot), verb: callable.slice(dot + 1) }) === null;
			}) ? null : forbidden;
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
		const workspace = c.workspace(),
			logo = workspace.icons?.[0]?.src;
		const env = environment_label(c.environment);
		const ws: ShellBoot['workspace'] = {
			name: workspace.name,
			handle: workspace.handle,
			locale: m.workspace.locale,
			tz: m.workspace.tz,
			...(logo === undefined ? {} : { logo }),
			...(env === null ? {} : { environment: env }),
			...(c.apex === undefined ? {} : { apex: c.apex }),
			...(c.live === undefined ? {} : { live: c.live }),
			...(c.organization === undefined ? {} : { organization: true as const })
		};
		// a kiosk boot names its kiosk: signed-out callers boot only public kiosks (no sign-in, the
		// requests run as the assigned policies); members boot any kiosk they may open, with the boot catalog
		// cut to what the kiosk may read. Anything else is unauthenticated (signed-out) or forbidden.
		const kioskName = Option.getOrNull(requestKiosk(request, true));
		if (kioskName !== null) {
			let v = yield* visitorOf(request);
			const meAuth = x.authority?.actor.kind === 'member' ? x.authority : null;
			const open = (visitor: Visitor) =>
				kioskBoot(m, kioskName, meAuth, visitor).pipe(Effect.provideService(Identity, identity));
			let opened = yield* open(v);
			if (opened._tag === 'Visitor' && !v.anonymous) {
				const minted = yield* mintVisitor(request, opened.authority);
				if (minted !== null) opened = yield* open((v = minted));
			}
			if (opened._tag === 'Unknown') return rejected(refused('not_found', 'No such kiosk.', 404));
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
					...(yield* bootFor(m, ws, me.auth, c.studio !== undefined)),
					name:
						Option.getOrNull(
							yield* db.one(Schema.Struct({ name: Schema.NullOr(Schema.String) }), {
								text: 'SELECT name FROM sys_user WHERE id = $1',
								params: [me.actor.id]
							})
						)?.name ?? null,
					preview: x.preview,
					catalog: yield* exposure(m, kioskAuth),
					read_catalog: yield* read_catalog(m, kioskAuth),
					automations: automation_inputs(m, kioskAuth),
					operation_outputs: operation_output_catalog(m, kioskAuth),
					search: manifestItems(m, kioskAuth, false)
				};
				return ready(b, kioskAuth);
			}
			const auth = opened.authority;
			const site_key =
				(challenge_of(m, kioskName) ?? m.workspace.signup?.challenge) === undefined
					? undefined
					: turnstile?.site_key;
			const b = {
				...(yield* bootFor(m, ws, auth)),
				nav: [],
				visitor: { app: kioskName, ...(site_key === undefined ? {} : { site_key }) }
			};
			return ready(b, auth, visitorCookie(v));
		}
		// a visitor page (unless the member signed in holds it): an anonymous user is minted when absent, and the page sees
		// only its own app
		if (app !== null && !(x.authority !== null && holds_public(x.authority, app))) {
			let v = yield* visitorOf(request);
			let auth = yield* authorities.visitor(app, v.id, v.anonymous);
			if (!v.anonymous) {
				const minted = yield* mintVisitor(request, auth);
				if (minted !== null) auth = yield* authorities.visitor(app, (v = minted).id, true);
			}
			const site_key =
				(challenge_of(m, app) ?? m.workspace.signup?.challenge) === undefined
					? undefined
					: turnstile?.site_key;
			const b = {
				...(yield* bootFor(m, ws, auth)),
				visitor: { app, ...(site_key === undefined ? {} : { site_key }) }
			};
			return ready(b, auth, visitorCookie(v));
		}
		const auth = x.authority;
		// a print (`?print`) boots its run's reads alone: no navigation, no member surfaces
		if (auth?.render === true) return ready({ ...(yield* bootFor(m, ws, auth)), nav: [] }, auth);
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
		const runtimeEnvoys = yield* activeEnvoys(h.db);
		const bundlePort = c.studio?.bundle?.bind(c.studio);
		const studio_bundle =
			s.studio && bundlePort !== undefined ? yield* hostCall(() => bundlePort()) : null;
		const b: ShellBoot = {
			...(yield* bootFor(m, ws, auth, c.studio !== undefined)),
			name: Option.getOrNull(user)?.name ?? null,
			preview: x.preview,
			surfaces: s,
			inbox: box === null ? 0 : box.requests.filter((r) => r.canDecide).length,
			push: s.inbox ? (c.push?.public_key ?? null) : null,
			...(c.ai === false ? { ai_unconfigured: true as const } : {}),
			...(notice === null ? {} : { notice }),
			...(c.client === undefined ? {} : { client: c.client }),
			...(studio_bundle === null ? {} : { studio_bundle }),
			...(workspaces.length === 0 ? {} : { workspaces }),
			envoys: Object.fromEntries(runtimeEnvoys.map(({ id, name }) => [id, name]))
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
		const url = requestUrl(request);
		const next = `${url.pathname}${url.search}`;
		url.searchParams.delete('app');
		url.searchParams.delete('kiosk');
		url.searchParams.set(
			target.kind === 'app' ? 'app' : 'kiosk',
			target.kind === 'app' ? target.app : target.kiosk
		);
		let headers = Headers.remove(Headers.remove(request.headers, VISITOR_APP), HEADERS.kiosk);
		if (target.kind === 'app') headers = Headers.set(headers, VISITOR_APP, target.app);
		const selected = request.modify({ url: url.pathname + url.search, headers });
		const x = yield* baseCaller(selected);
		// a page that needs sign-in sends a signed-out caller to sign in (or sign up), and back to it after
		if (x.authority === null && !is_open_route(m, route(m, url)))
			return rejected(
				HttpServerResponse.redirect(
					under(c.public_url, `/sign-in?next=${encodeURIComponent(next)}`),
					{ status: 303 }
				)
			);
		const state = yield* bootState(selected, x);
		if (state._tag === 'Refused') return state;
		if (target.kind === 'app' && !can_open(m, state.authority, target.app))
			return rejected(refused('forbidden', 'This page is not open to you.', 403));
		return {
			...state,
			request: selected,
			base: new URL(c.public_url).pathname.replace(/\/$/, ''),
			headers: state.headers
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
					// a challenged sign-up happens on a public page, which carries the check: this one does not
					signup:
						open &&
						h.signup !== undefined &&
						(m.workspace.signup?.challenge === undefined ||
							(turnstile.site_key === undefined && h.dev_sink === true))
							? h.signup.via.filter((via) => (via === 'email' ? h.mail !== undefined : phone))
							: []
				};
				return json({ value: methods });
			}),
		[`POST ${PATHS.session.code}`]: (request) =>
			Effect.gen(function* () {
				const body = yield* requestBody(request, SessionCode);
				const ip = Option.getOrElse(request.remoteAddress, () => '0.0.0.0'),
					token = getHeader(request, HEADERS.challenge);
				yield* send_code(
					h,
					body.address,
					ip,
					body.via === 'whatsapp' ? 'whatsapp' : 'sms',
					// a local host sends nothing real and has no check to run
					m.workspace.signup?.challenge === undefined ||
						(turnstile.site_key === undefined && h.dev_sink === true)
						? Effect.succeed(true)
						: token === null || token === ''
							? Effect.succeed(false)
							: turnstile.verify(token, ip).pipe(Effect.orElseSucceed(() => false))
				);
				return json({ value: null });
			}),
		[`POST ${PATHS.session.verify}`]: (request) =>
			Effect.gen(function* () {
				const body = yield* requestBody(
					request,
					Schema.Struct({ address: Schema.String, code: Schema.String })
				);
				// the visitor's anonymous user links to the account: a newcomer becomes it, an existing account absorbs it
				const v = yield* visitorOf(request);
				const session = yield* verify_code(
					h,
					body.address,
					body.code,
					Option.getOrElse(request.remoteAddress, () => '0.0.0.0'),
					v.anonymous ? v.id : null
				);
				if (v.anonymous && session.user !== v.id) yield* mergeAnonymous(h, m, v.id, session.user);
				const response = json({ value: { user: session.user } }, 200, {
					'set-cookie': cookie(names.session, session.token, SESSION_S)
				});
				return v.token === null
					? response
					: response.pipe(
							HttpServerResponse.setCookiesUnsafe([
								[
									names.visitor,
									'',
									{
										path: base_path(c.public_url) || '/',
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
		[`POST ${PATHS.session.signout}`]: (request) =>
			Effect.gen(function* () {
				const token = sessionToken(request, names.session);
				if (token !== null) {
					yield* revokeSession(h, token);
				}
				return HttpServerResponse.empty({ status: 204 }).pipe(
					HttpServerResponse.setCookiesUnsafe([
						[
							names.session,
							'',
							{
								path: base_path(c.public_url) || '/',
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
								path: base_path(c.public_url) || '/',
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
					? refused('not_found', 'No such invitation.', 404)
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
	const manageInstance = Effect.fn('shell.manageInstance')(function* (
		auth: Authority,
		instance: string
	) {
		const at = yield* h.now;
		// the instance's update checks judge a host verb on it
		const allowed = yield* mayUpdate(
			{ manifest: m, db, guest },
			'sys_integration',
			instance,
			auth,
			{
				now: at.toISOString(),
				today: DateTime.formatIsoDate(DateTime.makeZonedUnsafe(at, { timeZone: m.workspace.tz })),
				tz: m.workspace.tz
			}
		);
		if (allowed !== true)
			return yield* Effect.fail(
				BoltError.make(
					allowed === null ? 'not_found' : 'forbidden',
					'admission',
					allowed === null
						? 'No such integration instance.'
						: 'You may not manage this integration instance.'
				)
			);
	});
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
				// the Runs surface is staff's; a holder of an automation (external included) reads its runs through `bolt.runs`
				const one = url.searchParams.get('automation') ?? undefined;
				if (
					!s.runs &&
					!(one !== undefined && visible_run_names(auth).includes(one)) &&
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
					? refused('not_found', 'Not found or no access.', 404)
					: json({
							value: {
								...run,
								...(run.result === undefined
									? {}
									: {
											files: outputFiles(
												m.automations[run.automation]?.output,
												run.result,
												m.custom_fields,
												m.models
											)
										}),
								// who reads the run's input reads its log: what it printed can hold no less
								...(run.input === undefined ? {} : {
									logs: yield* runLog(logs, run.id),
									log_access: yield* runLogAccess(auth, run.id)
								})
							}
						});
			}
			case 'GET /runs/log': {
				const id = url.searchParams.get('id') ?? '';
				const access = url.searchParams.get('access') ?? '';
				const expected = yield* runLogAccess(auth, id);
				if (access.length !== expected.length || !timingSafeEqual(fromBase64(access), fromBase64(expected)))
					return refused('forbidden', 'Reopen the run to read its logs under your current access.', 403);
				return json({ value: yield* runLog(logs, id, url.searchParams.get('after') ?? undefined) });
			}
			case 'POST /runs/stop': {
				// hook:runtime — whoever reads the run in full may stop it
				const { id } = yield* requestBody(request, RunId);
				const run = yield* runs.stop(auth, id).pipe(Effect.map(Option.getOrNull));
				return run === null
					? refused('not_found', 'Not found or no access.', 404)
					: json({ value: run });
			}
			case 'GET /instance-messages': {
				const p = url.searchParams;
				return json({
					value: yield* instance_messages(
						h.db,
						auth,
						p.get('instance') ?? '',
						p.get('before') ?? undefined
					)
				});
			}
			case 'GET /instance-sync-health': {
				const instance = url.searchParams.get('instance') ?? '';
				yield* manageInstance(auth, instance);
				return json({ value: yield* syncs.health(instance) });
			}
			case 'POST /instance-sync-replay': {
				const { instance, ids } = yield* requestBody(request, SyncReplay);
				yield* manageInstance(auth, instance);
				return json({ value: yield* syncs.replay(instance, ids) });
			}
			case 'GET /instance-sync-dead-letters': {
				const instance = url.searchParams.get('instance') ?? '';
				yield* manageInstance(auth, instance);
				return json({ value: yield* syncs.dead_letters(instance) });
			}
			case 'POST /instance-sync-retire': {
				const { instance, id } = yield* requestBody(request, SyncRetire);
				yield* manageInstance(auth, instance);
				if (auth.actor.kind !== 'member')
					return refused('forbidden', 'A member must retire a write.', 403);
				return json({ value: yield* syncs.retire(instance, id, auth.actor.id) });
			}
			case 'POST /audit/query': {
				if (!auth.admin || auth.actor.kind !== 'member')
					return refused('forbidden', 'Only administrators may read the audit trail.', 403);
				const query = yield* requestBody(request, AuditQuery);
				return json({ value: yield* audit.query(query) });
			}
			case 'GET /audit/detail': {
				if (!auth.admin || auth.actor.kind !== 'member')
					return refused('forbidden', 'Only administrators may read the audit trail.', 403);
				const id = url.searchParams.get('id');
				if (id === null || id.length === 0)
					return yield* Effect.fail(invalid('An audit detail requires an event id.'));
				return json({ value: yield* audit.detail(id) });
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
				return json({
					value: yield* audited(
						h.db,
						{
							category: 'identity',
							action: op.op,
							actor: auditActor(auth.actor),
							payload: 
								op.op === 'setSecret'
									? { op: op.op, input: { name: op.input.name, value: '[credential redacted]' } }
									: op
							
						},
						applySettings(h, m, auth, op, secrets)
					).pipe(Effect.provideService(Audit, audit))
				});
			case 'POST /organization': {
				// L-COL-199: the workspace's logo, an administrator's (never a previewed member's)
				if (c.organization === undefined)
					return refused(
						'unavailable',
						'This host keeps the branding in the workspace source.',
						503
					);
				if (!auth.admin)
					return refused('forbidden', 'Only an administrator edits the organization.', 403);
				const b = yield* requestBody(request, Branding);
				const organization = c.organization,
					branding = { logo: b.logo ?? null };
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
				const bad = ['since', 'until']
					.map((key) => p.get(key))
					.find((v) => v !== null && v !== '' && Number.isNaN(Date.parse(v)));
				if (bad !== undefined)
					return yield* Effect.fail(
						BoltError.make('invalid_input', 'decode', `'${bad}' is not an instant`)
					);
				yield* requireAdmin(auth);
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
				};
				return json({ value: yield* readLog(logs, query) });
			}
			case 'GET /studio':
			case 'POST /studio': {
				if (!s.studio || c.studio === undefined)
					return refused('forbidden', 'Studio is for staff members on a host that serves it.', 403);
				const studio = c.studio;
				if (request.method === 'GET')
					return json({ value: studio_view(yield* hostCall(() => studio.state(auth))) });
				const op = Schema.decodeUnknownOption(StudioOp, { onExcessProperty: 'error' })(
					(yield* requestBody(request, Body))['op'] ?? null
				);
				if (Option.isNone(op)) return refused('check', 'The Studio operation is malformed.', 422);
				// a decision ends Norbius's held request: tell its conversation and wake the turn that asked
				const chosen = op.value,
					decided =
						chosen.op === 'approval.decide'
							? Option.getOrUndefined(
									yield* Effect.option(hostCall(() => studio.state(auth)))
								)?.approvals?.find((held) => held.id === chosen.id)
							: undefined;
				const value = yield* hostCall(() => studio.run(auth, op.value));
				const agents = yield* Effect.serviceOption(Agents);
				if (decided !== undefined && auth.actor.kind === 'member' && Option.isSome(agents)) {
					const action =
						decided.op.op === 'change.merge'
							? 'merge'
							: decided.op.op === 'rollback'
								? 'rollback'
								: 'request';
					const text =
						chosen.op === 'approval.decide' && chosen.kind === 'approved'
							? `The person approved your ${action}. It is running; workspace_review shows its progress.`
							: `The person rejected your ${action}; it did not run. Do not ask again unless something changed.`;
					yield* agents.value
						.notify({
							conversation: decided.conversation,
							text,
							as: { member: auth.actor.id }
						})
						.pipe(
							Effect.catch((cause) =>
								Effect.logWarning('The approval could not wake its conversation', cause)
							)
						);
				}
				return json({ value: studio_view(value) });
			}
			case 'GET /studio/file': {
				// one file's text on its own: a state carries the tree's sizes, never its contents
				const studio = c.studio,
					commit = url.searchParams.get('commit'),
					path = url.searchParams.get('path');
				if (!s.studio || studio === undefined)
					return refused('forbidden', 'Studio is for staff members on a host that serves it.', 403);
				if (commit === null || commit === '' || path === null || path === '')
					return refused('check', 'Give commit and path.', 422);
				return json({ value: yield* hostCall(() => studio.file(auth, commit, path)) });
			}
			case 'GET /studio/inspect': {
				const studio = c.studio;
				if (!s.studio || studio === undefined || !auth.admin)
					return refused(
						'forbidden',
						'Inspection is for administrators on a host that serves it.',
						403
					);
				const input = Schema.decodeUnknownOption(StudioInspectInput)(
					Object.fromEntries(url.searchParams)
				);
				if (Option.isNone(input))
					return refused('check', 'The inspection scope is malformed.', 422);
				return json({ value: yield* hostCall(() => studio.inspect(auth, input.value)) });
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
					Stream.callback<import('@norbital-ai/host-api').StudioFrame>((queue) =>
						Effect.acquireRelease(
							Effect.sync(() => watch(auth, (frame) => Queue.offerUnsafe(queue, frame))),
							(off) => Effect.sync(off)
						)
					)
				);
			}
			case 'POST /preview': {
				// only the real administrator may start or end a preview, of a member or a team; a preview
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
					yield* preview_as(x.real, authorities, h.db, h.publication, { team });
					return HttpServerResponse.empty({
						status: 204,
						headers: { 'set-cookie': cookie(names.preview, `${TEAM}${team}`, null) }
					});
				}
				if (typeof user !== 'string')
					return yield* Effect.fail(
						BoltError.make('invalid', 'decode', 'the body is { user } or { team }')
					);
				yield* preview_as(x.real, authorities, h.db, h.publication, user);
				return HttpServerResponse.empty({
					status: 204,
					headers: { 'set-cookie': cookie(names.preview, user, null) }
				});
			}
			case 'GET /explain': {
				// `access.explain`: the caller's own Authority, or (administrators) a member's or team's as a preview compiles it
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
					a = (yield* preview_as(x.real, authorities, h.db, h.publication, team !== null ? { team } : (user ?? '')))
						.authority;
				}
				const { key: _key, ...explained } = a;
				return json({ value: explained });
			}
		}
		return null;
	});
	/** `GET /manifest.webmanifest`: scope and start_url from the configured public origin, never `Host`. */
	function webmanifest(): HttpServerResponse.HttpServerResponse {
		const scope = under(h.public_url, '/'),
			workspace = c.workspace();
		return HttpServerResponse.text(
			JSON.stringify({
				id: workspace.handle,
				name: workspace.name,
				short_name: workspace.name,
				scope,
				start_url: scope,
				display: 'standalone',
				icons: workspace.icons ?? []
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
			// the request line as sent: `//x` would parse as an authority
			const at = request.url.indexOf('?'),
				sent = at < 0 ? request.url : request.url.slice(0, at);
			if (sent.startsWith('/') && canonical_path(sent) !== sent)
				return Option.some(
					HttpServerResponse.redirect(
						`${under(c.public_url, canonical_path(sent))}${at < 0 ? '' : request.url.slice(at)}`,
						{ status: 308 }
					)
				);
			if (duplicateCredentials(request, credentialNames))
				return Option.some(refused('invalid', 'Duplicate credentials are refused.', 400));
			const origin = getHeader(request, 'origin'),
				site = getHeader(request, 'sec-fetch-site');
			if (
				!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
				(site === 'cross-site' ||
					site === 'same-site' ||
					(origin !== null && origin !== new URL(c.public_url).origin))
			)
				return Option.some(refused('forbidden', 'A write from another site is refused.', 403));
			if (path === '/manifest.webmanifest' && request.method === 'GET')
				return Option.some(webmanifest());
			if (path === SW && request.method === 'GET')
				return Option.some(
					HttpServerResponse.text(PUSH_WORKER, {
						headers: {
							'content-type': 'text/javascript',
							'service-worker-allowed': `${base_path(h.public_url)}/`,
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
			Effect.catch((e) => Effect.succeed(Option.some(response_error(e)))),
			Effect.catchCause((cause) =>
				Effect.logWarning(cause).pipe(Effect.as(Option.some(response_error(cause))))
			)
		);
	return { authority, handle, publicPage };
});
/** The one shell's way to resolve a caller: what it remembers of them lives as long as the shell does. */
export const session_authority = Effect.map(makeShell, (shell) => shell.authority);
export const authority_of = (request: HttpServerRequest.HttpServerRequest) =>
	Effect.flatMap(SessionAuthority, (session) => session.of(request)).pipe(
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
