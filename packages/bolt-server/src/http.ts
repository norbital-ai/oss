// The http driver's request: what a host's http provider runs for an instance's `ctx.request`. The path
// resolves under the definition's base URL (a literal, or a text configuration field) and never leaves it; auth comes
// from the instance's sealed `credential` fields (bearer, header, basic) or, for a definition declaring `oauth`, its
// OAuth `token` (refreshed before expiry with that client and written back through the instance's credentials; only a
// refused grant deletes it, and only while no concurrent refresh stored a newer one), and the call goes through
// the host's HTTP port under its public-network policy (HTTPS, pinned DNS, private ranges refused). A `429` or `503`
// answers its `Retry-After` beside `{ status, body }`.
// Credentials never reach the guest; a path that leaves the base, or a request outside the definition's `allow`, is
// refused before any credential is read.
import { Clock, Effect, Option, Predicate, Schema } from 'effect';
import type { Json } from 'effect/Schema';
import {
	FacilityFailure,
	type Fenced,
	HOST_LIMITS,
	http_allows,
	http_auth,
	http_target,
	type HttpPort,
	type IntegrationDefinition,
	Port,
	type PortFailure,
	Unavailable
} from '@norbital-ai/host-api';

const Token = Schema.Struct({
	access: Schema.String,
	refresh: Schema.optionalKey(Schema.String),
	exp: Schema.Number
});
const TokenResponse = Schema.Struct({
	access_token: Schema.optionalKey(Schema.String),
	refresh_token: Schema.optionalKey(Schema.String),
	expires_in: Schema.optionalKey(Schema.Number),
	error: Schema.optionalKey(Schema.String)
});
const SKEW_MS = 60_000;
const REVOKED = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);
/** One request through the host's network policy: five redirects, a 2 MiB body; the answer's body as text. */
const send = (
	http: HttpPort,
	url: string,
	method: string,
	headers: Record<string, string>,
	body?: string
) =>
	Effect.gen(function* () {
		const response = yield* Port.attempt('http', (signal) =>
			http.fetch(
				{
					method,
					url,
					headers: Object.entries(headers),
					...(body === undefined ? {} : { body: new TextEncoder().encode(body) })
				},
				{ redirects: 5, max_bytes: 2 * 1024 * 1024 },
				signal
			)
		);
		return {
			status: response.status,
			text: new TextDecoder().decode(response.body),
			retryAfter: response.headers.find(([name]) => name === 'retry-after')?.[1],
			scopes: response.headers.find(([name]) => name === 'x-oauth-scopes')?.[1]
		};
	}).pipe(Port.call('request', HOST_LIMITS.callMs.http));
export type HttpInstance = {
	readonly configuration: Json;
	readonly credentials: ReadonlyMap<string, Json>;
	readonly write?:
		| ((changes: ReadonlyMap<string, Json | null>) => Effect.Effect<void, Fenced | PortFailure>)
		| undefined;
};
export type HttpOptions = {
	readonly secrets?: Readonly<Record<string, string>> | undefined;
};
/** An `http` integration's OAuth client, when its definition declares both `authorize` and `token` URLs; else `undefined`. */
export const http_oauth = (
	def: IntegrationDefinition
):
	| { client: string; secret: string; authorize: string; token: string; scopes?: readonly string[] }
	| undefined => {
	const oauth = def.driver === 'http' ? def.oauth : undefined;
	return oauth?.authorize === undefined || oauth.token === undefined
		? undefined
		: { ...oauth, authorize: oauth.authorize, token: oauth.token };
};
const invalid = (message: string) => FacilityFailure.invalid(message);
const GITHUB = 'https://api.github.com/';
/**
 * A read-only GitHub connection's bearer credential field: its base is GitHub's API and its `allow` admits only `GET`
 * and `HEAD`. `undefined` for any other definition.
 */
export const github_read_only = (def: IntegrationDefinition): string | undefined => {
	const spec = def.http,
		auth = spec?.auth;
	return spec?.base_url === GITHUB &&
		spec.allow !== undefined &&
		spec.allow.methods.every((method) => method === 'GET' || method === 'HEAD') &&
		auth !== undefined &&
		'bearer' in auth
		? auth.bearer
		: undefined;
};
/** What a read-only GitHub connection's token field asks for. */
export const GITHUB_TOKEN_HINT = {
	en: 'A fine-grained token with Contents: Read-only on the repositories you choose.',
	zh: '一个细粒度令牌，仅对你选择的仓库授予 Contents: Read-only 权限。'
};
const READ_ONLY = 'use a fine-grained token with Contents: Read-only';
/**
 * Checks a read-only GitHub connection's token before it is stored: only a fine-grained one (`github_pat_…`; a classic
 * `ghp_…` token's private-repository scope `repo` writes), and `GET /user` must accept it with no write scope in its
 * `X-OAuth-Scopes`. Refusals never carry the token or the request's error.
 */
export const github_token = (token: string, http: HttpPort) =>
	Effect.gen(function* () {
		if (!token.startsWith('github_pat_'))
			return yield* Effect.fail(
				invalid(
					token.startsWith('ghp_')
						? `a classic token can write to every repository it reaches; ${READ_ONLY}`
						: `this is not a fine-grained GitHub token (github_pat_…); ${READ_ONLY}`
				)
			);
		const response = yield* send(http, `${GITHUB}user`, 'GET', {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'user-agent': 'norbital'
		}).pipe(
			Effect.mapError(
				() =>
					new FacilityFailure({
						kind: 'upstream',
						message: 'GitHub could not be reached to check the token'
					})
			)
		);
		if (response.status === 401) return yield* Effect.fail(invalid('GitHub refused the token'));
		if (response.status < 200 || response.status >= 300)
			return yield* Effect.fail(
				new FacilityFailure({
					kind: 'upstream',
					message: `GitHub answered ${response.status} checking the token`
				})
			);
		const writes = (response.scopes ?? '')
			.split(',')
			.map((scope) => scope.trim())
			.filter((scope) => scope !== '' && !scope.startsWith('read:'));
		if (writes.length > 0)
			return yield* Effect.fail(
				invalid(`the token carries write scopes (${writes.join(', ')}); ${READ_ONLY}`)
			);
	});
const unavailable = (reason: string) => new Unavailable({ facility: 'http', reason });
/**
 * Sends one `{ method, path, query?, headers?, body? }` request for an `http` integration instance against its base URL,
 * authenticated by its OAuth token (refreshed when expired), bearer, basic or header credential. Answers the status,
 * the JSON (else text) body and, on a 429 or 503, `retryAfter` in seconds.
 */
export const http_request = (
	def: IntegrationDefinition,
	instance: HttpInstance,
	op: Json,
	http: HttpPort,
	options: HttpOptions = {}
) =>
	Effect.gen(function* () {
		const spec = def.http;
		if (def.driver !== 'http' || spec === undefined)
			return yield* Effect.fail(
				new FacilityFailure({ kind: 'unsupported', message: 'this definition makes no http request' })
			);
		if (
			!Predicate.isObject(op) ||
			typeof op['method'] !== 'string' ||
			typeof op['path'] !== 'string'
		)
			return yield* Effect.fail(invalid('an http request is { method, path, … }'));
		const base = spec.base_url.startsWith('https://')
			? spec.base_url
			: Predicate.isObject(instance.configuration)
				? instance.configuration[spec.base_url]
				: undefined;
		if (typeof base !== 'string' || base === '')
			return yield* Effect.fail(unavailable('the instance has no base URL configured'));
		const path = op['path'],
			method = op['method'];
		const url = yield* Effect.try({
			try: () => http_target(base, path),
			catch: (error) =>
				error instanceof FacilityFailure ? error : invalid('the request URL is invalid')
		});
		if (!http_allows(spec.allow, base, method, url))
			return yield* Effect.fail(
				new FacilityFailure({
					kind: 'unsupported',
					message: `this connection does not allow ${method.toUpperCase()} ${url.pathname}`
				})
			);
		for (const [key, value] of Object.entries(Predicate.isObject(op['query']) ? op['query'] : {}))
			url.searchParams.set(key, String(value));
		const headers: Record<string, string> = {
			accept: 'application/json',
			...(op['body'] === undefined ? {} : { 'content-type': 'application/json' }),
			...Object.fromEntries(
				Object.entries(Predicate.isObject(op['headers']) ? op['headers'] : {}).map(
					([key, value]) => [key.toLowerCase(), String(value)]
				)
			)
		};
		const oauth = http_oauth(def);
		if (oauth !== undefined)
			headers['authorization'] = `Bearer ${yield* token(oauth, instance, http, options)}`;
		else {
			const signed = http_auth(spec.auth, instance.credentials.get('credential'));
			if (signed === undefined)
				return yield* Effect.fail(unavailable('the instance is not paired: its credential is missing'));
			Object.assign(headers, signed);
		}
		const response = yield* send(
			http,
			url.href,
			method,
			headers,
			op['body'] === undefined ? undefined : JSON.stringify(op['body'])
		);
		const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(response.text);
		// a 429's or 503's `Retry-After` (seconds, or an HTTP date) paces the instance's next request (instances.ts)
		const wait =
			response.retryAfter === undefined || (response.status !== 429 && response.status !== 503)
				? undefined
				: /^\d+$/.test(response.retryAfter)
					? Number(response.retryAfter)
					: Math.ceil((Date.parse(response.retryAfter) - (yield* Clock.currentTimeMillis)) / 1000);
		return {
			status: response.status,
			body: Option.isSome(json) ? json.value : response.text,
			...(wait === undefined || !Number.isFinite(wait) || wait <= 0 ? {} : { retryAfter: wait })
		};
	});
const token = (
	client: { client: string; secret: string; token: string },
	instance: HttpInstance,
	http: HttpPort,
	options: HttpOptions
) =>
	Effect.gen(function* () {
		const stored = yield* Schema.decodeUnknownEffect(Token)(instance.credentials.get('token')).pipe(
			Effect.mapError(() => unavailable('the instance is not paired: it holds no token'))
		);
		const now = yield* Clock.currentTimeMillis;
		if (stored.exp - SKEW_MS > now) return stored.access;
		if (stored.refresh === undefined)
			return yield* Effect.fail(unavailable('the token expired; pair the instance again'));
		const refresh = stored.refresh;
		const secret = (name: string) =>
			Effect.suspend(() => {
				const value = options.secrets?.[name];
				return value === undefined || value === ''
					? Effect.fail(unavailable(`${name} is not set`))
					: Effect.succeed(value);
			});
		const client_id = yield* secret(client.client),
			client_secret = yield* secret(client.secret);
		const response = yield* send(
			http,
			client.token,
			'POST',
			{ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
			new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refresh,
				client_id: client_id,
				client_secret: client_secret
			}).toString()
		);
		const raw = Schema.decodeUnknownOption(Schema.fromJsonString(TokenResponse))(response.text);
		const answer = Option.isSome(raw) ? raw.value : {};
		const ok = response.status >= 200 && response.status < 300;
		if (!ok || answer.access_token === undefined) {
			if (
				(response.status !== 400 && response.status !== 401) ||
				answer.error === undefined ||
				!REVOKED.has(answer.error)
			)
				return yield* Effect.fail(
					new FacilityFailure({
						kind: response.status === 429 ? 'rate_limited' : 'upstream',
						message: `the token endpoint answered ${response.status}`
					})
				);
			if (instance.write !== undefined)
				yield* instance
					.write(new Map([['token', null]]))
					.pipe(
						Effect.catch((error) =>
							error._tag === 'Fenced'
								? Effect.fail(
										new FacilityFailure({
											kind: 'upstream',
											message: 'the token was refreshed by another request meanwhile; try again'
										})
									)
								: Effect.fail(error)
						)
					);
			return yield* Effect.fail(
				unavailable(
					`the token endpoint refused the grant (${answer.error}); pair the instance again`
				)
			);
		}
		const next = {
			access: answer.access_token,
			refresh: answer.refresh_token ?? stored.refresh,
			exp: now + (answer.expires_in ?? 3600) * 1000
		};
		if (instance.write !== undefined)
			yield* instance
				.write(new Map([['token', next]]))
				.pipe(Effect.catch((error) => (error._tag === 'Fenced' ? Effect.void : Effect.fail(error))));
		return next.access;
	});
