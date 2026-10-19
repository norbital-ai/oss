// Every host registers this provider catalogue through toDrivers(defs, run).
import { Clock, Effect, Option, Schema } from 'effect';
import {
	DatabaseRequest,
	DatabaseResult,
	httpOAuth,
	httpRequest,
	OAUTH_CALLBACK,
	Port,
	publicFetch,
	type DriverOpen,
	type Json,
	type SetupDescription,
	type SetupField
} from '@norbital-ai/bolt/engine';
import {
	attempt,
	authorizeUrl,
	defaultProviders,
	grant,
	same,
	STATE_MS,
	field,
	hostCall,
	withFetch,
	type OAuthApp
} from '@norbital-ai/providers';
import { ProviderRuntime, type ProviderDef } from '@norbital-ai/providers/abi';
import {
	PairingInvalid,
	ProviderRefused,
	ProviderUnavailable
} from '@norbital-ai/providers/errors';
import { sqlServerDatabase } from './database.ts';

export type DriversOptions = {
	readonly fetch?: typeof fetch;
	readonly database?: ReturnType<typeof sqlServerDatabase>;
};
export function drivers(options: DriversOptions = {}): readonly ProviderDef[] {
	return [
		...defaultProviders(),
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
const appOf = (oauth: NonNullable<ReturnType<typeof httpOAuth>>): OAuthApp => ({
	authorizeUrl: oauth.authorize,
	tokenUrl: oauth.token,
	scopes: oauth.scopes ?? []
});
const unavailable = (error: { readonly message: string }) =>
	new ProviderUnavailable({ message: error.message });

export function httpProvider(options: Pick<DriversOptions, 'fetch'> = {}): ProviderDef {
	const setup = (d: Definition): SetupDescription =>
		httpOAuth(d) !== undefined
			? {
					kind: 'form',
					steps: [
						{
							text: {
								en: 'Register this redirect URI with the OAuth app, then sign in.',
								zh: '在 OAuth 应用中登记此重定向 URI，然后登录。'
							},
							copy: 'redirectUrl'
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
		label: 'HTTP',
		setup: { kind: 'none', steps: [] },
		describe: ({ definition }) => ({ label: 'HTTP', setup: setup(definition) }),
		open: Effect.fn('HTTP.open')(function* (ctx: DriverOpen) {
			const definition = ctx.definition,
				oauth = httpOAuth(definition);
			const run = yield* ProviderRuntime;
			const guarded = { fetch: options.fetch ?? publicFetch(run) };
			let pending: { state: string; verifier: string; at: number } | null = null;
			/** The definition's own OAuth app, from the workspace's secrets. */
			const own = Effect.suspend(() => {
				const client = ctx.oauthClient();
				return client === undefined
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
						return yield* httpRequest(
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
							{ fetch: guarded.fetch, secrets }
						).pipe(
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
					const paired = attempt(ctx.state());
					const url = authorizeUrl(
						appOf(oauth),
						(yield* own).id,
						ctx.redirectUrl,
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
							redirect_uri: ctx.redirectUrl,
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
		label: 'SQL Server',
		setup: { kind: 'form', steps: [] },
		describe: ({ definition }) => ({
			label: 'SQL Server',
			setup: { kind: 'form', steps: [], fields: credentialFields(definition) }
		}),
		open: Effect.fn('SQLServer.open')(function* (ctx: DriverOpen) {
			return {
				close: Effect.void,
				// The engine runs the workspace's integration test body after this provider phase.
				test: () => Effect.void,
				pair: (input: Json) =>
					Effect.gen(function* () {
						const value = yield* credentials(ctx.definition, input);
						yield* hostCall('write SQL Server credential', () =>
							ctx.credentials.write(new Map([['credential', value]]))
						);
						yield* hostCall('report SQL Server status', () => ctx.status({ state: 'connected' }));
					}),
				request: (operation: Json) =>
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
						const request = yield* Schema.decodeUnknownEffect(DatabaseRequest)(operation).pipe(
							Effect.mapError(
								() => new ProviderRefused({ message: 'Invalid database request.', permanent: true })
							)
						);
						const result = yield* database
							.query(connection, request)
							.pipe(Effect.mapError(unavailable));
						return yield* Schema.decodeUnknownEffect(DatabaseResult)(result).pipe(
							Effect.mapError(
								() => new ProviderUnavailable({ message: 'Invalid database result.' })
							)
						);
					})
			};
		})
	};
}
