import {
	Clock,
	Config as EffectConfig,
	ConfigProvider,
	Context,
	Crypto,
	Deferred,
	Effect,
	FiberSet,
	FileSystem,
	Layer,
	Option,
	Redacted,
	Result,
	Schema
} from 'effect';
import { HttpClient } from 'effect/unstable/http';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import {
	readArtifact,
	loadPackWithAssets,
	workspaceFiles,
	type Artifact
} from '@norbital-ai/bolt/artifact';
import { toDrivers, openRouterSpeech } from '@norbital-ai/providers';
import { aiModalityRefusals } from '@norbital-ai/providers/openrouter';
import {
	Activation,
	Audit,
	AgentHost,
	Ai,
	BoltError,
	BoltHostLive,
	Convert,
	Drivers,
	EngineLive,
	Files,
	Geo,
	GuestIsolates,
	HostIdentity,
	Http,
	Docs,
	Images,
	IntegrationManager,
	Keys,
	Mcp,
	Metering,
	Port,
	PublicPages,
	publicPages,
	RateLimits,
	Secrets,
	ShellConfig,
	ShellRoutes,
	Speech,
	TenantDb,
	Transport,
	WebRead,
	applyMigrations,
	auditFromAbi,
	challengedApps,
	declaredSecrets,
	credentials,
	documentConverter,
	founderBootstrap,
	inProcessDeadlines,
	integrationLinks,
	loadKeys,
	makeIdentityHost,
	RateWindows,
	readPackSource,
	Runs,
	signupOf,
	Turnstile,
	type EngineManifest,
	type EngineServices,
	type EngineHost,
	type Provider
} from '@norbital-ai/bolt/engine';
import { cronClock, localAudit, localFiles, nodePorts } from '@norbital-ai/bolt/node';
import { s3Files, nominatim, openAi } from './ports.ts';
import { publicWeb } from './web.ts';
import { messaging, type Sender } from './mail.ts';
import { apns, push } from './push.ts';
import type { Config } from './config.ts';
import { drivers } from './drivers.ts';
import { envelope } from './envelope.ts';

export type StartOptions = {
	readonly mail?: Sender;
	readonly providers?: readonly Provider[];
	readonly contracts?: readonly string[];
	readonly maxConcurrent?: number;
	readonly log?: (line: string) => void;
};
const endpoint = (provider: NonNullable<Config['providers']['AI_SYS_2']>) => ({
	endpoint: provider.endpoint ?? 'https://openrouter.ai/api/v1',
	...(provider.credential === undefined ? {} : { credential: provider.credential })
});
export const prepare = Effect.fn('server.prepare')(function* (
	config: Config,
	options: StartOptions = {}
) {
	const artifact = yield* readArtifact(config.artifact, options.contracts),
		manifest = artifact.manifest;
	const log = options.log ?? ((line: string) => console.log(`[bolt] ${line}`));
	const checked = requirements(config, manifest, options);
	if (checked.errors.length > 0)
		return yield* Effect.fail(
			BoltError.make('invalidSpec', 'admission', checked.errors.join('\n'))
		);
	for (const warning of checked.warnings) log(`warning: ${warning}`);
	if (config.files?.provider === 's3') {
		const fileEndpoint = config.files.endpoint;
		yield* Effect.try({
			try: () => new URL(fileEndpoint),
			catch: (cause) =>
				BoltError.make(
					'invalidSpec',
					'admission',
					cause instanceof Error ? cause.message : 'Invalid URL',
					cause
				)
		});
	}
	const files =
		config.files === null
			? yield* Effect.fail(BoltError.make('unavailable', 'facility', 'The server requires files.'))
			: config.files.provider === 'local'
				? localFiles(config.files.root)
				: yield* s3Files(config.files.endpoint, config.files.credential);
	const sys2 = config.providers.AI_SYS_2,
		embed = config.providers.AI_EMBED;
	if (sys2 !== undefined) {
		const refusals = yield* aiModalityRefusals(
			[
				{
					system: 'sys_2',
					endpoint: { baseUrl: endpoint(sys2).endpoint, apiKey: sys2.credential },
					models: Object.values(config.ai.sys2),
					declared: config.ai.modalities.sys2 ?? undefined,
					env: 'BOLT_AI_SYS_2_MODALITIES'
				},
				...(embed === undefined
					? []
					: [
							{
								system: 'embed' as const,
								endpoint: { baseUrl: endpoint(embed).endpoint, apiKey: embed.credential },
								models: Object.values(config.ai.embed).map((model) =>
									typeof model === 'string' ? model : model.model
								),
								declared: config.ai.modalities.embed ?? undefined,
								env: 'BOLT_AI_EMBED_MODALITIES'
							}
						])
			],
			{ tolerateUnread: false }
		);
		if (refusals.length > 0)
			return yield* Effect.fail(BoltError.make('invalidSpec', 'admission', refusals.join('\n')));
	}
	const prepared: { artifact: Artifact; files: Files['Service']; warnings: readonly string[] } = {
		artifact,
		files,
		warnings: checked.warnings
	};
	return prepared;
});
export const activate = Effect.fn('server.activate')(function* (
	config: Config,
	prepared: Effect.Success<ReturnType<typeof prepare>>,
	options: StartOptions = {}
) {
	const { artifact, files, warnings } = prepared,
		manifest = artifact.manifest,
		db = yield* TenantDb;
	const log = options.log ?? ((line: string) => console.log(`[bolt] ${line}`));
	yield* applyMigrations(db, manifest, artifact.migrations);
	const pack = config.seed === null ? undefined : yield* readPackSource(config.seed);
	if (pack !== undefined) {
		const loaded = yield* loadPackWithAssets(
			db,
			manifest,
			pack,
			files,
			new Date(yield* Clock.currentTimeMillis).toISOString()
		);
		log(
			loaded
				? `--seed: loaded pack ${pack.meta.name} (${pack.meta.hash.slice(0, 12)})`
				: '--seed: the database has rows; nothing seeded'
		);
	}
	const crypto = yield* Crypto.Crypto;
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(config.auditDir, { recursive: true });
	const auditDir = yield* fs.realPath(config.auditDir);
	if ('pglite' in config.database && auditDir === (yield* fs.realPath(config.database.pglite)))
		return yield* Effect.fail(
			BoltError.make(
				'invalidSpec',
				'admission',
				'The audit database must be separate from the tenant database.'
			)
		);
	const audit = yield* localAudit(auditDir);
	const epochId = yield* crypto.randomUUIDv4.pipe(
		Effect.mapError((error) =>
			BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
		)
	);
	const [storedEpoch] = yield* db.returning(Schema.Struct({ value: Schema.String }), {
		text: `INSERT INTO sys_config (key,value) VALUES ('epoch',$1) ON CONFLICT (key) DO UPDATE SET value = sys_config.value RETURNING value`,
		params: [epochId]
	});
	if (storedEpoch === undefined)
		return yield* Effect.fail(
			BoltError.make('internal', 'commit', 'The epoch initialization returned no row.')
		);
	const epoch = storedEpoch.value;
	const admitted = yield* envelope(options.maxConcurrent ?? 8);
	const contextReady = yield* Deferred.make<Context.Context<EngineServices | TenantDb>>();
	const enter = <A, E>(work: Effect.Effect<A, E, EngineServices | TenantDb>) =>
		Deferred.await(contextReady).pipe(
			Effect.flatMap((context) => work.pipe(Effect.provide(context)))
		);
	const runProviderRuntime = yield* FiberSet.makeRuntimePromise<HttpClient.HttpClient>();
	const runProviders = <A, E>(
		effect: Effect.Effect<A, E>,
		options?: { readonly signal?: AbortSignal | undefined }
	) => runProviderRuntime(Effect.result(effect), options).then(Result.getOrThrow);
	const providers = options.providers ?? (yield* toDrivers(drivers(), runProviders));
	const native = yield* nodePorts({
			release: artifact.dir,
			...(config.masterKey === null ? {} : { secretsKey: config.masterKey })
		}),
		keys = Keys.fromAbi(native.keys);
	const secretContext = yield* Layer.build(
		Secrets.layer(declaredSecrets(manifest)).pipe(
			Layer.provide(Layer.mergeAll(Layer.succeed(TenantDb, db), keys))
		)
	);
	const codec = Context.get(secretContext, Secrets);
	const secrets = Object.fromEntries(
		(yield* Effect.forEach(declaredSecrets(manifest), (name) =>
			EffectConfig.option(EffectConfig.string(name)).pipe(
				Effect.provideService(ConfigProvider.ConfigProvider, codec.config),
				Effect.map((value) => (Option.isSome(value) ? [[name, value.value] as const] : []))
			)
		)).flat()
	);
	const manager = yield* integrationLinks({
		providers,
		credentials: yield* credentials(db, codec),
		publicUrl: config.publicUrl,
		secrets,
		oauth: config.googleOAuth === null ? {} : { google: config.googleOAuth },
		log,
		enter,
		admit: enter
	});
	const mail = yield* messaging(config, log),
		httpContext = yield* Effect.context<HttpClient.HttpClient>();
	const apnsPush = apns(db, config.apns);
	const transport: Transport['Service'] = {
		send: (message) => {
			if (message._tag === 'Push')
				return message.subscription.kind === 'apns'
					? apnsPush.send(message)
					: config.vapid === null
						? Port.unavailable('push')
						: push(db, config.vapid, config.publicUrl).send(message);
			if (message._tag === 'Mail' && options.mail !== undefined) return options.mail(message);
			const port = message._tag === 'Mail' ? mail.email : mail.sms;
			return port === undefined
				? Port.unavailable(message._tag === 'Mail' ? 'email' : 'sms')
				: port
						.send(message)
						.pipe(Effect.provide(httpContext), Effect.mapError(Port.failure('transport')));
		}
	};
	const sys1 = config.providers.AI_SYS_1,
		sys2 = config.providers.AI_SYS_2,
		embed = config.providers.AI_EMBED;
	const declared = [...(manifest.workspace.ai?.models ?? [])];
	const ai =
		sys1 === undefined || sys2 === undefined
			? Ai.unavailable
			: Layer.succeed(
					Ai,
					yield* openAi(
						{
							sys1: { ...endpoint(sys1), provider: sys1.provider },
							sys2: endpoint(sys2),
							...(embed === undefined ? {} : { embed: endpoint(embed) })
						},
						config.ai,
						declared,
						files.get
					)
				);
	const geo =
		config.providers.GEO === undefined
			? Geo.unavailable
			: Layer.succeed(
					Geo,
					yield* nominatim(config.providers.GEO.endpoint ?? 'https://nominatim.openstreetmap.org')
				);
	const converter = config.providers.CONVERT;
	const convert =
		converter?.endpoint === undefined || converter.credential === undefined
			? Convert.unavailable
			: Layer.succeed(
					Convert,
					documentConverter({ url: converter.endpoint, key: converter.credential })
				);
	const speechContext = yield* Effect.context<import('@norbital-ai/providers').SpeechServices>();
	const speechDef =
		config.speech === null
			? undefined
			: openRouterSpeech({
					baseUrl: config.speech.endpoint,
					apiKey: config.speech.credential,
					...(config.speech.transcribe === null
						? {}
						: { transcribeModel: config.speech.transcribe }),
					...(config.speech.speak === null ? {} : { speakModel: config.speech.speak }),
					...(config.speech.voice === null ? {} : { speakVoice: config.speech.voice })
				});
	const speech =
		speechDef === undefined
			? Speech.unavailable
			: Layer.succeed(Speech, {
					transcribe: (audio, options) =>
						speechDef.transcribe === undefined
							? Port.unavailable('ai.transcribe')
							: speechDef
									.transcribe(audio, options)
									.pipe(
										Effect.provide(speechContext),
										Effect.mapError(Port.failure('ai.transcribe'))
									),
					speak: (text, options) =>
						speechDef.speak === undefined
							? Port.unavailable('ai.speak')
							: speechDef
									.speak(text, options)
									.pipe(Effect.provide(speechContext), Effect.mapError(Port.failure('ai.speak')))
				});
	const workspace = yield* workspaceFiles(artifact.dir);
	const ports = Layer.mergeAll(
		NodeFileSystem.layer,
		NodePath.layer,
		Layer.succeed(Crypto.Crypto, crypto),
		auditFromAbi(audit).pipe(Layer.provide(Layer.succeed(Crypto.Crypto, crypto))),
		Layer.succeed(AgentHost, workspace === undefined ? {} : { workspace }),
		Layer.succeed(TenantDb, db),
		keys,
		GuestIsolates.fromAbi(native.guestIsolates),
		Http.fromAbi(native.http),
		Images.fromAbi(native.images),
		Docs.fromAbi(native.docs),
		Mcp.fromAbi(native.mcp),
		Layer.succeed(Files, files),
		Layer.succeed(Transport, transport),
		Layer.succeed(Drivers, manager.port),
		Layer.succeed(IntegrationManager, Option.some(manager)),
		ai,
		geo,
		convert,
		speech,
		Metering.unavailable,
		config.providers.WEB === undefined ? WebRead.unavailable : Layer.succeed(WebRead, publicWeb()),
		inProcessDeadlines(() => enter(Effect.flatMap(Runs, (runs) => admitted.admit(1, runs.tick)))),
		Layer.succeed(Activation, {
			scope: 'start',
			epoch,
			release: artifact.artifact.hash,
			publicUrl: config.publicUrl,
			guest: Option.some(artifact.guest),
			start: pack?.meta.start ?? []
		})
	);
	const engineContext = yield* Layer.build(EngineLive(manifest).pipe(Layer.provideMerge(ports)));
	yield* Deferred.succeed(contextReady, engineContext);
	const runs = Context.get(engineContext, Runs);
	yield* cronClock({
		crons: runs.crons,
		fire: (id, slot) => admitted.admit(1, runs.fire(id, slot))
	});
	const phone = mail.phone;
	const identity = yield* makeIdentityHost({
		audit: Context.get(engineContext, Audit),
		db,
		now: Clock.currentTimeMillis.pipe(Effect.map((at) => new Date(at))),
		windows: new RateWindows(),
		keys: yield* loadKeys(db),
		publicUrl: config.publicUrl,
		mail: {
			send: (_kind, message, signal) =>
				runProviders(
					transport.send({
						_tag: 'Mail',
						...Schema.decodeUnknownSync(
							Schema.Struct({
								to: Schema.String,
								subject: Schema.String,
								text: Schema.String,
								html: Schema.optionalKey(Schema.String)
							})
						)(message)
					}),
					{ signal }
				)
		},
		...(phone === undefined
			? {}
			: {
					phone: {
						via: phone.via,
						start: (to, via, signal) => runProviders(phone.start(to, via), { signal }),
						check: (to, code, signal) => runProviders(phone.check(to, code), { signal })
					}
				}),
		devSink: config.mode === 'dev',
		...(signupOf(manifest) === undefined ? {} : { signup: signupOf(manifest) })
	});
	if (config.founder !== null) yield* founderBootstrap(identity, config.founder);
	const turnstile =
		config.mode === 'dev'
			? Turnstile.dev
			: config.turnstile === null
				? Turnstile.unavailable
				: Turnstile.cloudflare(config.turnstile.siteKey, Redacted.make(config.turnstile.secret));
	const shell = ShellRoutes.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Layer.succeed(HostIdentity, identity),
				Layer.succeed(ShellConfig, {
					publicUrl: config.publicUrl,
					workspace: () => ({ name: artifact.artifact.name, handle: artifact.artifact.handle }),
					secure: config.publicUrl.startsWith('https:'),
					ai: sys2 !== undefined,
					...(config.environment === null ? {} : { environment: config.environment }),
					...(config.vapid === null ? {} : { push: { publicKey: config.vapid.publicKey } })
				}),
				turnstile,
				RateLimits.layer
			).pipe(Layer.provideMerge(Layer.succeedContext(engineContext)))
		)
	);
	const context = yield* Layer.build(
		Layer.merge(BoltHostLive, publicPages(artifact)).pipe(Layer.provideMerge(shell))
	);
	yield* manager.resume;
	const activated: {
		artifact: Artifact;
		context: Context.Context<
			| EngineServices
			| PublicPages
			| EngineHost
			| Context.Service.Identifier<typeof AgentHost | typeof IntegrationManager>
			| Layer.Success<typeof BoltHostLive>
			| Layer.Services<typeof BoltHostLive>
			| Layer.Success<typeof ShellRoutes>
			| Layer.Services<typeof ShellRoutes>
		>;
		envelope: Effect.Success<ReturnType<typeof envelope>>;
		warnings: readonly string[];
	} = { artifact, context, envelope: admitted, warnings };
	return activated;
});

export function requirements(
	c: Config,
	m: EngineManifest,
	o: StartOptions
): { errors: string[]; warnings: string[] } {
	const errors: string[] = [],
		warnings: string[] = [];
	if (c.files === null)
		errors.push(
			'files are required: set BOLT_FILES_PROVIDER (local or s3) and BOLT_FILES_ENDPOINT'
		);
	// the host's messaging (sign-in codes, invitations): a local host without it prints to its log
	const local = c.mode !== 'production';
	if (c.transactional?.email === undefined && o.mail === undefined && !local)
		errors.push(
			'mail is required for sign-in: set BOLT_TRANSACTIONAL_EMAIL (resend or sinch) and its keys'
		);
	if (signupOf(m)?.via.includes('phone') === true && c.transactional?.phone === undefined && !local)
		errors.push(
			'this workspace lets people sign up by mobile number: set BOLT_TRANSACTIONAL_PHONE (twilio or sinch) and its keys'
		);
	if (c.masterKey === null && declaredSecrets(m).length > 0)
		errors.push('this workspace declares secrets: set BOLT_MASTER_KEY');
	if (challengedApps(m).length > 0 && c.turnstile === null && c.mode !== 'dev')
		errors.push(
			'an app declares challenge: turnstile: set BOLT_TURNSTILE_SITE_KEY and BOLT_TURNSTILE_SECRET'
		);
	const ai = m.workspace.ai;
	// hook:ai — the AI facility (P35): `sys_1` and `sys_2` both (config.ts refuses one without the other), `embed` beside them
	if (c.providers.AI_SYS_2 !== undefined) {
		const unmapped = (ai?.models ?? []).filter((n) => c.ai.sys2[n] === undefined);
		if (unmapped.length > 0)
			errors.push(`BOLT_AI_SYS_2_MODELS maps no model to ${unmapped.join(', ')}`);
	}
	if (c.providers.AI_EMBED !== undefined) {
		const unmapped = (ai?.embeddings ?? []).filter((n) => c.ai.embed[n] === undefined);
		if (unmapped.length > 0)
			errors.push(`BOLT_AI_EMBED_MODELS maps no model to ${unmapped.join(', ')}`);
	}
	// `workspace.convert.to` (ctx.convert.document): the one converter serves every target, so only its absence warns
	const declaredTargets = m.workspace.convert?.to ?? [];
	if (declaredTargets.length > 0 && c.providers.CONVERT === undefined)
		warnings.push(
			`this workspace converts to ${declaredTargets.join(', ')} but no converter is configured (BOLT_CONVERT_PROVIDER=norbital): those calls answer Unavailable`
		);
	// an instance's credentials are sealed with the master key, entered by an administrator at pairing
	if (
		c.masterKey === null &&
		(Object.keys(m.connections).length > 0 || Object.keys(m.integrations).length > 0)
	)
		warnings.push(
			'this workspace declares integrations but BOLT_MASTER_KEY is not set: an administrator cannot pair them'
		);
	const optional: [boolean, string][] = [
		[
			c.providers.AI_SYS_2 === undefined &&
				(ai?.models !== undefined ||
					ai?.embeddings !== undefined ||
					m.agent.internal !== undefined ||
					m.agent.external !== undefined),
			'AI'
		],
		[c.providers.GEO === undefined, 'geocoding'],
		[c.vapid === null, 'web push']
	];
	for (const [absent, name] of optional)
		if (absent)
			warnings.push(
				`${name} is not configured: its calls answer Unavailable${name === 'AI' ? '; messages start turns without triage and the AI filter is hidden' : ''}`
			);
	return { errors, warnings };
}
