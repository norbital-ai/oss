// bolt-server's example untethered host (plan 01): its OWN adapters composed into one `Facilities` record and the
// `serving` parts around it, from typed settings. The example `norbital.host.ts` (`../example/`) reads those settings
// from its environment; nothing here reads env. Nothing is guessed: an unconfigured member is `off`, and `activate`'s
// needs check refuses a bundle that needs it.
import { Effect, FiberSet, FileSystem, Option, Result, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { aiModalityRefusals } from '@norbital-ai/providers/openrouter';
import { toDrivers } from '@norbital-ai/providers';
import {
	BoltError,
	documentConverter,
	Port,
	type FilesPort,
	type LogPort,
	type LogRow
} from '@norbital-ai/bolt/engine';
import { off, type Challenge, type Facilities, type Serving } from '@norbital-ai/bolt/facilities';
import { httpPort, keysPort, localAudit, localFiles, tcpPort } from '@norbital-ai/bolt/node';
import { drivers } from './drivers.ts';
import { messaging } from './mail.ts';
import { nominatim, openAi, s3Files } from './ports.ts';
import { apns, push } from './push.ts';
import { openRouterSpeech, type SpeechServices } from './speech.ts';
import { publicWeb } from './web.ts';

/** One optional facility's selection: the provider name, its endpoint and credential. */
export type Provider = { provider: string; endpoint?: string; credential?: string };
export type Facility = 'AI_SYS_1' | 'AI_SYS_2' | 'AI_EMBED' | 'GEO' | 'CONVERT' | 'WEB';
/**
 * The host's transactional messaging, every part explicit: `email` is mandatory (`resend`, or `log`: each message is a
 * log line); `phone` is `twilio`, `log` (codes printed to the log) or absent (off).
 */
export type Transactional = {
	email: { provider: 'resend'; key: string; from: string } | { provider: 'log' };
	phone: { provider: 'twilio'; accountSid: string; authToken: string } | { provider: 'log' } | null;
};
export type AiModel = string | { model: string; inputs?: number; tokens?: number };
/** What this host is configured with. */
export type HostSettings = {
	/** The workspace's public origin: webhook URLs and the OAuth callback are under it. */
	publicUrl: string;
	/** Separate durable audit database directory; retained across process and artifact restarts. */
	auditDir: string;
	files: { provider: 'local'; root: string } | { provider: 's3'; endpoint: string; credential: string };
	/** Seals the tenant's secrets. */
	masterKey: Buffer;
	/** Host Google app shared by Gmail and Calendar where the workspace declares none of its own. */
	googleOAuth: { id: string; secret: string } | null;
	transactional: Transactional;
	providers: { readonly [F in Facility]?: Provider };
	/**
	 * The AI facility (P35, P39): `sys1` the sys_1 model id (`openai`: a structured-output chat model; `decisions`:
	 * OpenRouter's Decisions API); `sys2` each model class → model id; `embed` each embedding name → model.
	 */
	ai: {
		sys1: string | null;
		sys2: { readonly [modelClass: string]: string };
		embed: { readonly [embedding: string]: AiModel };
	};
	/** `ctx.ai.transcribe` and `ctx.ai.speak` over OpenRouter; null when off. */
	speech: {
		endpoint: string;
		credential: string;
		transcribe: string;
		speak: string;
		voice: string | null;
	} | null;
	vapid: { publicKey: string; privateKey: string } | null;
	/** Each Apple team's provider-token key (its id and `.p8` PEM), by team id; `{}` sends no APNs. */
	apns: { readonly [teamId: string]: { readonly keyId: string; readonly key: string } };
	turnstile: { siteKey: string; secret: string } | null;
	/** `production`, `staging`, `development`, …: every other than production shows the shell's badge. */
	environment: string | null;
};

// the settings carry every AI endpoint: none is guessed
const endpoint = (provider: Provider) => ({
	endpoint: provider.endpoint ?? '',
	...(provider.credential === undefined ? {} : { credential: provider.credential })
});
/** Cloudflare Turnstile's siteverify: this host's challenge facility. */
const cloudflare = (siteKey: string, secret: string): Challenge => ({
	siteKey,
	verify: async (token, ip, signal) => {
		const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			body: new URLSearchParams({ secret, response: token, remoteip: ip }),
			signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
		});
		const answer = Schema.decodeUnknownOption(Schema.Struct({ success: Schema.Boolean }))(
			await response.json()
		);
		return Option.isSome(answer) && answer.value.success;
	}
});
const RANK = { info: 0, warn: 1, error: 2 } as const;
/** The runtime log in this process's memory (the last 10,000 events), each also one line through `log`. */
// ponytail: memory only, gone with the process; a durable store is the next host's
const memoryLog = (log: (line: string) => void): LogPort => {
	const rows: LogRow[] = [];
	let next = 0;
	return {
		write: (event) => {
			rows.push({ ...event, id: String(++next).padStart(12, '0') });
			if (rows.length > 10_000) rows.shift();
			log(JSON.stringify(event));
		},
		query: async (q) => {
			const text = q.text?.toLowerCase();
			return rows
				.filter(
					(row) =>
						(q.before === undefined || row.id < q.before) &&
						(q.after === undefined || row.id > q.after) &&
						(q.level === undefined || row.severity === q.level) &&
						(q.min === undefined || RANK[row.severity] >= RANK[q.min]) &&
						(q.run === undefined || row.run === q.run) &&
						(q.conversation === undefined || row.conversation === q.conversation) &&
						(q.since === undefined || row.at >= q.since) &&
						(q.until === undefined || row.at < q.until) &&
						(q.automation === undefined ||
							JSON.stringify(row.attributes).includes(JSON.stringify(q.automation))) &&
						(text === undefined ||
							`${row.event} ${JSON.stringify(row.attributes)}`.toLowerCase().includes(text))
				)
				.reverse()
				.slice(0, q.limit ?? 200);
		}
	};
};
const PushBody = Schema.Struct({
	subscription: Schema.Struct({
		kind: Schema.Literals(['web', 'apns']),
		endpoint: Schema.String,
		keys: Schema.Json
	}),
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
	path: Schema.String,
	link: Schema.NullOr(Schema.Struct({ model: Schema.String, id: Schema.String }))
});

/**
 * This host's facilities over `database` and the parts it serves around them, alive while the scope is. `database` is
 * the tenant database the caller opened; `pglite` names its directory, which the audit database must not share.
 */
export const host = Effect.fn('server.host')(function* (
	config: HostSettings,
	database: Facilities['storage']['database'],
	options: { readonly pglite?: string; readonly log: (line: string) => void }
) {
	const log = options.log;
	const sys1 = config.providers.AI_SYS_1,
		sys2 = config.providers.AI_SYS_2,
		embed = config.providers.AI_EMBED;
	if (sys2 !== undefined) {
		const refusals = yield* aiModalityRefusals(
			[
				{
					system: 'sys_2',
					endpoint: { baseUrl: endpoint(sys2).endpoint, apiKey: sys2.credential },
					models: Object.values(config.ai.sys2)
				},
				...(embed === undefined
					? []
					: [
							{
								system: 'embed' as const,
								endpoint: { baseUrl: endpoint(embed).endpoint, apiKey: embed.credential },
								models: Object.values(config.ai.embed).map((model) =>
									typeof model === 'string' ? model : model.model
								)
							}
						])
			],
			{ tolerateUnread: false }
		);
		if (refusals.length > 0)
			return yield* Effect.fail(BoltError.make('invalidSpec', 'admission', refusals.join('\n')));
	}
	const runtime = yield* FiberSet.makeRuntimePromise<HttpClient.HttpClient>();
	const run = <A, E>(
		effect: Effect.Effect<A, E, HttpClient.HttpClient>,
		options?: { readonly signal?: AbortSignal | undefined }
	) => runtime(Effect.result(effect), options).then(Result.getOrThrow);
	const files =
		config.files.provider === 'local'
			? localFiles(config.files.root)
			: yield* s3Files(config.files.endpoint, config.files.credential);
	const filesPort: FilesPort = {
		put: (bytes, meta, signal) => run(files.put(bytes, meta), { signal }),
		get: (key, max, signal) => run(files.get(key, max), { signal }),
		url: (key, expiresInS, signal) => run(files.url(key, expiresInS), { signal }),
		remove: (key, signal) => run(files.remove(key), { signal }),
		download: (url, signal) => run(files.download(url), { signal })
	};
	const messages = yield* messaging(config, run, log);
	const intelligence =
		sys1 === undefined || sys2 === undefined
			? { system1: off, system2: off, embed: off }
			: yield* openAi(
					{
						sys1: { ...endpoint(sys1), provider: sys1.provider },
						sys2: endpoint(sys2),
						...(embed === undefined ? {} : { embed: endpoint(embed) })
					},
					config.ai,
					Object.keys(config.ai.sys2),
					files.get,
					run
				);
	const speechContext = yield* Effect.context<SpeechServices>();
	const speech =
		config.speech === null
			? undefined
			: openRouterSpeech({
					baseUrl: config.speech.endpoint,
					apiKey: config.speech.credential,
					transcribeModel: config.speech.transcribe,
					speakModel: config.speech.speak,
					...(config.speech.voice === null ? {} : { speakVoice: config.speech.voice })
				});
	const transcribe = speech?.transcribe,
		speak = speech?.speak;
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(config.auditDir, { recursive: true });
	const auditDir = yield* fs.realPath(config.auditDir);
	if (options.pglite !== undefined && auditDir === (yield* fs.realPath(options.pglite)))
		return yield* Effect.fail(
			BoltError.make(
				'invalidSpec',
				'admission',
				'The audit database must be separate from the tenant database.'
			)
		);
	const vapid = config.vapid;
	const facilities: Facilities = {
		storage: { database, files: filesPort },
		logs: { runtime: memoryLog(log), audit: yield* localAudit(auditDir) },
		transactional: {
			mail: messages.mail,
			sms: messages.sms,
			phone: messages.phone,
			push: (database) => {
				// a gone subscription is deleted on the database the engine hands over
				const db = {
					write: (statement: Parameters<typeof database.write>[0]) =>
						Effect.tryPromise({
							try: (signal) => database.write(statement, undefined, signal),
							catch: Port.failure('push')
						})
				};
				const ios = apns(db, config.apns);
				return {
					send: (_kind, message, signal) =>
						run(
							Schema.decodeUnknownEffect(PushBody)(message).pipe(
								Effect.mapError(Port.failure('push')),
								Effect.flatMap((input) =>
									input.subscription.kind === 'apns'
										? ios.send({ _tag: 'Push', ...input })
										: vapid === null
											? Port.unavailable('push', 'This host has no VAPID keys.')
											: push(db, vapid, config.publicUrl).send({ _tag: 'Push', ...input })
								)
							),
							{ signal }
						)
				};
			},
			challenge:
				config.turnstile === null
					? off
					: cloudflare(config.turnstile.siteKey, config.turnstile.secret)
		},
		intelligence: {
			...intelligence,
			speech:
				transcribe === undefined || speak === undefined
					? off
					: {
							transcribe: (audio, o, signal) =>
								run(transcribe(audio, o).pipe(Effect.provide(speechContext)), { signal }),
							speak: (text, o, signal) =>
								run(speak(text, o).pipe(Effect.provide(speechContext)), { signal })
						}
		},
		ports: {
			webhooks: { publicUrl: config.publicUrl },
			websockets: off,
			outbound: {
				http: httpPort,
				tcp: tcpPort
			}
		},
		sandbox: off,
		keys: keysPort(config.masterKey)
	};
	const converter = config.providers.CONVERT;
	const documents =
		converter?.endpoint === undefined || converter.credential === undefined
			? undefined
			: documentConverter({ url: converter.endpoint, key: converter.credential });
	const geo =
		config.providers.GEO?.endpoint === undefined
			? undefined
			: yield* nominatim(config.providers.GEO.endpoint);
	const web = config.providers.WEB === undefined ? undefined : publicWeb();
	const serving: Serving = {
		providers: yield* toDrivers(drivers(), run),
		...(config.googleOAuth === null ? {} : { oauth: { google: config.googleOAuth } }),
		...(documents === undefined
			? {}
			: {
					convert: {
						targets: documents.targets,
						convert: (source, to, o, signal) => run(documents.convert(source, to, o), { signal })
					}
				}),
		...(geo === undefined
			? {}
			: {
					geocoder: {
						search: (query, signal) => run(geo.search(query), { signal }),
						reverse: (point, signal) => run(geo.reverse(point), { signal })
					}
				}),
		...(web === undefined
			? {}
			: { web: { read: (url, signal, o) => run(web.read(url, o), { signal }) } }),
		shell: {
			...(config.environment === null ? {} : { environment: config.environment }),
			...(vapid === null ? {} : { push: { publicKey: vapid.publicKey } })
		}
	};
	return { facilities, serving };
});
