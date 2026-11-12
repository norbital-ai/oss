// Every host registers this provider catalogue through to_drivers(defs, run).
import { Clock, Effect, Option, Schema } from 'effect';
import {
	DatabaseRequest,
	DatabaseResult,
	http_oauth,
	http_request,
	OAUTH_CALLBACK,
	Http,
	Port,
	type DriverOpen,
	type Json,
	type SetupDescription,
	type SetupField
} from '@norbital-ai/bolt/engine';
import { http_port, public_fetch } from '@norbital-ai/bolt/node';
import { FacilityFailure } from '@norbital-ai/bolt/errors';
import {
	attempt,
	authorizeUrl,
	default_providers,
	grant,
	same,
	STATE_MS,
	field,
	hostCall,
	withFetch,
	type OAuthApp
} from '@norbital-ai/providers';
import { simulatedProviders } from '@norbital-ai/providers/simulator';
import { ProviderRuntime, type ProviderDef } from '@norbital-ai/providers/abi';
import {
	PairingInvalid,
	ProviderRefused,
	ProviderUnavailable
} from '@norbital-ai/providers/errors';
import { sqlServerDatabase } from './database.ts';

type DriversOptions = {
	readonly fetch?: typeof fetch;
	readonly database?: ReturnType<typeof sqlServerDatabase>;
	/** A channel simulator's URL: its providers are offered beside the real ones. */
	readonly simulator?: string | undefined;
};
/** An injected fetch (a test's) as the engine's HTTP port; without one, requests take the public-network guard. */
const fetchHttp = (fetcher: typeof fetch): typeof http_port => ({
	fetch: async (request, _limits, signal) => {
		const response = await fetcher(request.url, {
			method: request.method,
			headers: request.headers.map(([name, value]): [string, string] => [name, value]),
			...(request.body === undefined ? {} : { body: new Uint8Array(request.body) }),
			signal
		});
		return {
			status: response.status,
			headers: [...response.headers],
			body: new Uint8Array(await response.arrayBuffer())
		};
	}
});
export function drivers(options: DriversOptions = {}): readonly ProviderDef[] {
	return [
		...default_providers(),
		...(options.simulator === undefined ? [] : simulatedProviders(options.simulator)),
		httpProvider(options),
		sqlServerProvider(options.database ?? sqlServerDatabase())
	];
}
type Definition = DriverOpen['definition'];
const credentialFields = (definition: Definition): SetupField[] =>
	Object.entries(definition.credential ?? {}).map(([name, value]) => ({
		name,
		label: value.label ?? name,
		secret: true,
		...(value.optional === true ? { optional: true } : {})
	}));
const Credential = Schema.Record(Schema.String, Schema.String);
const credentials = Effect.fn('Drivers.credentials')(function* (
	definition: Definition,
	input: Json
) {
	const decoded = yield* Schema.decodeUnknownEffect(Credential)(input).pipe(
		Effect.mapError(() => new PairingInvalid({ message: 'credential fields must be text' }))
	);
	const values: Record<string, string> = {};
	for (const [name, spec] of Object.entries(definition.credential ?? {})) {
		if (spec.optional === true && !decoded[name]?.trim()) continue;
		values[name] = yield* field(decoded, name, spec.label ?? name);
	}
	return values;
});
const appOf = (oauth: NonNullable<ReturnType<typeof http_oauth>>): OAuthApp => ({
	authorizeUrl: oauth.authorize,
	tokenUrl: oauth.token,
	scopes: oauth.scopes ?? []
});
const unavailable = (error: { readonly message: string }) =>
	new ProviderUnavailable({ message: error.message });

export function httpProvider(options: Pick<DriversOptions, 'fetch'> = {}): ProviderDef {
	const setup = (d: Definition): SetupDescription =>
		http_oauth(d) !== undefined
			? {
					kind: 'form',
					steps: [
						{
							text: {
								en: 'Register this redirect URI with the OAuth app, then sign in.',
								zh: '在 OAuth 应用中登记此重定向 URI，然后登录。'
							},
							copy: 'redirect_url'
						}
					]
				}
			: d.credential === undefined
				? { kind: 'none', steps: [], ...(d.webhook === undefined ? {} : { webhook: true }) }
				: {
						kind: 'form',
						steps: [],
						fields: credentialFields(d),
						...(d.webhook === undefined ? {} : { webhook: true })
					};
	return {
		_tag: 'ProviderDef',
		driver: 'http',
		id: 'http',
		label: { en: 'HTTP', zh: 'HTTP' },
		setup: { kind: 'none', steps: [] },
		describe: ({ definition }) => ({ label: { en: 'HTTP', zh: 'HTTP' }, setup: setup(definition) }),
		open: Effect.fn('HTTP.open')(function* (ctx: DriverOpen) {
			const definition = ctx.definition,
				oauth = http_oauth(definition);
			const run = yield* ProviderRuntime;
			// OAuth token exchanges take a fetch; the definition's own requests take the engine's HTTP port
			const guarded = { fetch: options.fetch ?? public_fetch(run) };
			const http = Http.fromAbi(options.fetch === undefined ? http_port : fetchHttp(options.fetch));
			let pending: { state: string; verifier: string; at: number } | null = null;
			/** The definition's own OAuth app, from the workspace's secrets. */
			const own = Effect.gen(function* () {
				const client = yield* hostCall('read OAuth client', () => ctx.oauth_client());
				return yield* client === undefined
					? Effect.fail(
							new ProviderUnavailable({
								message: `${oauth?.client ?? 'the OAuth client'} is not set`
							})
						)
					: Effect.succeed(client);
			});
			return {
				close: Effect.void,
				// The engine runs the workspace's integration test body after this provider phase.
				test: () => Effect.void,
				request: (operation: Json) =>
					Effect.gen(function* () {
						const stored = yield* hostCall('read HTTP credentials', () => ctx.credentials.load());
						const secrets: Record<string, string> = {};
						if (oauth !== undefined) {
							const client = yield* own;
							secrets[oauth.client] = client.id;
							secrets[oauth.secret] = client.secret;
						}
						return yield* http_request(
							definition,
							{
								configuration: ctx.configuration,
								credentials: stored,
								write: (changes) =>
									hostCall('write HTTP credential', () => ctx.credentials.write(changes)).pipe(
										Effect.mapError((error) =>
											error._tag === 'Fenced' ? error : Port.failure('HTTP credential')(error)
										)
									)
							},
							operation,
							{ secrets }
						).pipe(
							Effect.provide(http),
							Effect.mapError((error) => (error._tag === 'Fenced' ? error : unavailable(error)))
						);
					}),
				pair: Effect.fn('HTTP.pair')(function* (input: Json) {
					if (oauth === undefined) {
						const value = yield* credentials(definition, input);
						yield* hostCall('write HTTP credential', () =>
							ctx.credentials.write(new Map([['credential', value]]))
						);
						yield* hostCall('report HTTP status', () => ctx.status({ state: 'connected' }));
						return;
					}
					const paired = attempt(yield* hostCall('read pairing state', () => ctx.state()));
					const url = authorizeUrl(
						appOf(oauth),
						(yield* own).id,
						ctx.redirect_url,
						paired.state,
						paired.challenge
					);
					pending = {
						state: paired.state,
						verifier: paired.verifier,
						at: yield* Clock.currentTimeMillis
					};
					yield* Effect.sync(() => ctx.pairing({ kind: 'oauth', value: url, label: 'Sign in' }));
					yield* hostCall('report HTTP status', () => ctx.status({ state: 'pairing' }));
				}),
				webhook: Effect.fn('HTTP.webhook')(function* (request: Request) {
					const url = new URL(request.url);
					if (oauth === undefined || !url.pathname.endsWith(OAUTH_CALLBACK))
						return new Response(null, { status: 404 });
					const code = url.searchParams.get('code'),
						paired = pending;
					if (
						paired === null ||
						!same(url.searchParams.get('state') ?? '', paired.state) ||
						(yield* Clock.currentTimeMillis) - paired.at > STATE_MS ||
						code === null
					)
						return new Response('This sign-in expired; start it again.', { status: 400 });
					pending = null;
					const result = yield* withFetch(
						guarded,
						grant(appOf(oauth), yield* own, {
							grant_type: 'authorization_code',
							code,
							redirect_uri: ctx.redirect_url,
							code_verifier: paired.verifier
						})
					).pipe(
						Effect.map(Option.some),
						Effect.catchTag('OAuthRefused', (error) =>
							hostCall('report HTTP status', () =>
								ctx.status({ state: 'error', error: `${error.message}; start it again.` })
							).pipe(Effect.as(Option.none()))
						)
					);
					if (Option.isNone(result))
						return new Response('The sign-in was refused; start it again.', { status: 400 });
					yield* hostCall('write HTTP token', () =>
						ctx.credentials.write(new Map<string, Json>([['token', result.value]]))
					);
					yield* hostCall('report HTTP status', () => ctx.status({ state: 'connected' }));
					return new Response('Signed in. You can close this window.', {
						headers: { 'content-type': 'text/plain; charset=utf-8' }
					});
				})
			};
		})
	};
}

export function sqlServerProvider(database: ReturnType<typeof sqlServerDatabase>): ProviderDef {
	return {
		_tag: 'ProviderDef',
		driver: 'sqlserver',
		id: 'sqlserver',
		label: { en: 'SQL Server', zh: 'SQL Server' },
		setup: { kind: 'form', steps: [] },
		describe: ({ definition }) => ({
			label: { en: 'SQL Server', zh: 'SQL Server' },
			setup: { kind: 'form', steps: [], fields: credentialFields(definition) }
		}),
		open: Effect.fn('SQLServer.open')(function* (ctx: DriverOpen) {
			const request = (operation: Json) =>
				Effect.gen(function* () {
					const stored = yield* hostCall('read SQL Server credential', () =>
						ctx.credentials.load()
					);
					const credential = yield* Schema.decodeUnknownEffect(Credential)(
						stored.get('credential')
					).pipe(
						Effect.mapError(
							() =>
								new ProviderUnavailable({
									message: 'the instance is not paired: its connection string is missing'
								})
						)
					);
					const [connection, ...rest] = Object.values(credential);
					if (connection === undefined || rest.length !== 0)
						return yield* Effect.fail(
							new ProviderUnavailable({
								message: 'the instance is not paired: its connection string is missing'
							})
						);
					const request = yield* Schema.decodeUnknownEffect(DatabaseRequest, { onExcessProperty: 'error' })(operation).pipe(
						Effect.mapError(
							() => new ProviderRefused({ message: 'Invalid database request.', permanent: true })
						)
					);
					const result = yield* database.query(connection, request).pipe(
						Effect.mapError(
							(error) =>
								new FacilityFailure({
									kind:
										error.code === 'timeout'
											? 'timeout'
											: error.code === 'upstream'
												? 'upstream'
												: 'invalid',
									message: error.message
								})
						)
					);
					return yield* Schema.decodeUnknownEffect(DatabaseResult)(result).pipe(
						Effect.mapError(() => new ProviderUnavailable({ message: 'Invalid database result.' }))
					);
				});
			return {
				close: Effect.void,
				test: () =>
					request({ op: 'values', values: { connected: 1 }, max_rows: 1 }).pipe(Effect.asVoid),
				pair: (input: Json) =>
					Effect.gen(function* () {
						const value = yield* credentials(ctx.definition, input);
						yield* hostCall('write SQL Server credential', () =>
							ctx.credentials.write(new Map([['credential', value]]))
						);
					}),
				request
			};
		})
	};
}
