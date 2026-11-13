// bolt-server's example untethered host (plan 01): its OWN adapters composed into one `Facilities` record and the
// `serving` parts around it, from typed settings. The example `norbital.host.ts` (`../example/`) reads those settings
// from its environment; nothing here reads env. Nothing is guessed: an unconfigured member is `off`, and `activate`'s
// needs check refuses a bundle that needs it.
import {
	Crypto,
	Effect,
	FiberSet,
	FileSystem,
	Option,
	PlatformError,
	Result,
	Schema,
	Scope
} from 'effect';
import { HttpClient } from 'effect/http';
import { ai_modality_refusals } from '@norbital-ai/providers/openrouter';
import { to_drivers } from '@norbital-ai/providers';
import {
	BoltError,
	document_converter,
	document_ingester,
	Port,
	type FilesPort,
	type LogRow
} from '@norbital-ai/bolt/engine';
import { off, type Challenge, type Facilities, type Serving } from '@norbital-ai/bolt/facilities';
import { default_facilities } from '@norbital-ai/bolt/node';
import { drivers } from './drivers.ts';
import { messaging } from './mail.ts';
import { nominatim, openAi, s3Files } from './ports.ts';
import { apns, push } from './push.ts';
import { webSearch } from './search.ts';
import { publicWeb } from './web.ts';
import { chromium_render } from './render.ts';

/** One optional facility's selection: the provider name, its endpoint and credential. */
export type Provider = { provider: string; endpoint?: string; credential?: string };
export type Facility = 'AI_SYS_1' | 'AI_SYS_2' | 'AI_EMBED' | 'GEO' | 'CONVERT' | 'WEB' | 'SEARCH';
/**
 * The host's transactional messaging, every part explicit: `email` is mandatory (`resend`, or `log`: each message is a
 * log line); `phone` is `twilio`, `log` (codes printed to the log) or absent (off).
 */
type Transactional = {
	email: { provider: 'resend'; key: string; from: string } | { provider: 'log' };
	phone: { provider: 'twilio'; account_sid: string; auth_token: string } | { provider: 'log' } | null;
};
export type AiModel = string | { model: string; inputs?: number; tokens?: number };
/** What this host is configured with. */
export type HostSettings = {
	/** The workspace's public origin: webhook URLs and the OAuth callback are under it. */
	public_url: string;
	/** Separate durable audit database directory; retained across process and artifact restarts. */
	audit_dir: string;
	files:
		{ provider: 'local'; root: string } | { provider: 's3'; endpoint: string; credential: string };
	/** Seals the tenant's secrets. */
	master_key: Buffer;
	/** Host Google app shared by Gmail and Calendar where the workspace declares none of its own. */
	google_oauth: { id: string; secret: string } | null;
	transactional: Transactional;
	providers: { readonly [F in Facility]?: Provider };
	/**
	 * The AI facility (P35, P39): `sys1` the sys_1 model id (`openai`: a structured-output chat model; `decisions`:
	 * Jev/OpenRouter's Decisions API; `openai-decisions`: OpenAI's native Decisions API).
	 * `sys2` maps model classes to model ids; `embed` maps embedding names to models.
	 */
	ai: {
		sys1: string | null;
		sys2: { readonly [modelClass: string]: string };
		embed: { readonly [embedding: string]: AiModel };
	};
	vapid: { public_key: string; private_key: string } | null;
	/** Each Apple team's provider-token key (its id and `.p8` PEM), by team id; `{}` sends no APNs. */
	apns: { readonly [teamId: string]: { readonly key_id: string; readonly key: string } };
	turnstile: { site_key: string; secret: string } | null;
	/** `production`, `staging`, `development`, …: every other than production shows the shell's badge. */
	environment: string | null;
	/** `ctx.convert.record`'s browser: headless Chromium launched here (`cdp: null`) or the one at a CDP endpoint; `null`, off. */
	render: { cdp: string | null } | null;
};

// the settings carry every AI endpoint: none is guessed
const endpoint = (provider: Provider) => ({
	endpoint: provider.endpoint ?? '',
	...(provider.credential === undefined ? {} : { credential: provider.credential })
});
/** Cloudflare Turnstile's siteverify: this host's challenge facility. */
const cloudflare = (site_key: string, secret: string): Challenge => ({
	site_key,
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
const memoryLog = (log: (line: string) => void): Facilities['logs']['runtime'] => {
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
	id: Schema.String,
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
export const host: (
	config: HostSettings,
	database: Facilities['storage']['database'],
	options: { readonly pglite?: string; readonly log: (line: string) => void }
) => Effect.Effect<
	{ facilities: Facilities; serving: Serving },
	BoltError | PlatformError.PlatformError,
	Scope.Scope | HttpClient.HttpClient | Crypto.Crypto | FileSystem.FileSystem
> = Effect.fn('server.host')(function* (
	config: HostSettings,
	database: Facilities['storage']['database'],
	options: { readonly pglite?: string; readonly log: (line: string) => void }
) {
	const log = options.log;
	const sys1 = config.providers.AI_SYS_1,
		sys2 = config.providers.AI_SYS_2,
		embed = config.providers.AI_EMBED;
	if (sys2 !== undefined) {
		const refusals = yield* ai_modality_refusals(
			[
				{
					system: 'sys_2',
					endpoint: { base_url: endpoint(sys2).endpoint, api_key: sys2.credential },
					models: Object.values(config.ai.sys2)
				},
				...(embed === undefined
					? []
					: [
							{
								system: 'embed' as const,
								endpoint: { base_url: endpoint(embed).endpoint, api_key: embed.credential },
								models: Object.values(config.ai.embed).map((model) =>
									typeof model === 'string' ? model : model.model
								)
							}
						])
			],
			{ tolerate_unread: false }
		);
		if (refusals.length > 0)
			return yield* Effect.fail(BoltError.make('invalid_spec', 'admission', refusals.join('\n')));
	}
	const runtime = yield* FiberSet.makeRuntimePromise<HttpClient.HttpClient>();
	const run = <A, E>(
		effect: Effect.Effect<A, E, HttpClient.HttpClient>,
		options?: { readonly signal?: AbortSignal | undefined }
	) => runtime(Effect.result(effect), options).then(Result.getOrThrow);
	const node = yield* default_facilities({
		audit_dir: config.audit_dir,
		master_key: config.master_key,
		pglite: options.pglite
	});
	const files =
		config.files.provider === 'local'
			? node.local_files(config.files.root)
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
	const vapid = config.vapid;
	const facilities: Facilities = {
		storage: { database, files: filesPort },
		logs: { runtime: memoryLog(log), audit: node.audit },
		transactional: {
			mail: messages.mail,
			sms: messages.sms,
			phone: messages.phone,
			fixed_codes: messages.fixed_codes,
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
											: push(db, vapid, config.public_url).send({ _tag: 'Push', ...input })
								)
							),
							{ signal }
						)
				};
			},
			challenge:
				config.turnstile === null
					? off
					: cloudflare(config.turnstile.site_key, config.turnstile.secret)
		},
		intelligence,
		ports: {
			webhooks: { public_url: config.public_url },
			websockets: off,
			outbound: node.outbound
		},
		sandbox: off,
		keys: node.keys
	};
	const converter = config.providers.CONVERT;
	const documents =
		converter?.endpoint === undefined || converter.credential === undefined
			? undefined
			: document_converter({ url: converter.endpoint, key: converter.credential });
	const geo =
		config.providers.GEO?.endpoint === undefined
			? undefined
			: yield* nominatim(config.providers.GEO.endpoint);
	const web = config.providers.WEB === undefined ? undefined : publicWeb();
	const search = config.providers.SEARCH;
	const render = config.render === null ? undefined : chromium_render(config.public_url, config.render.cdp);
	if (render !== undefined) yield* Effect.addFinalizer(() => Effect.promise(() => render.close()));
	const serving: Serving = {
		providers: yield* to_drivers(drivers(), run),
		...(config.google_oauth === null ? {} : { oauth: { google: config.google_oauth } }),
		...(documents === undefined ||
		converter?.endpoint === undefined ||
		converter.credential === undefined
			? {}
			: {
					ingest: document_ingester({ url: converter.endpoint, key: converter.credential }).ingest,
					convert: {
						targets: documents.targets,
						convert: (source, to, o, signal) => run(documents.convert(source, to, o), { signal }),
						preview_pdf: (source, options, signal) =>
							run(documents.previewPdf(source, options), { signal })
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
		...(render === undefined ? {} : { render: { pdf: render.pdf } }),
		...(search?.endpoint === undefined || search.credential === undefined
			? {}
			: {
					host_tools: [webSearch({ endpoint: search.endpoint, credential: search.credential })]
				}),
		shell: {
			...(config.environment === null ? {} : { environment: config.environment }),
			...(vapid === null ? {} : { push: { public_key: vapid.public_key } })
		}
	};
	return { facilities, serving };
});
