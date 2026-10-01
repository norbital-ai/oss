// `bolt start` (§5.11.6, rules 69–72): one workspace from one built artifact on the next engine. Activation checks the
// artifact and the required facilities, applies the schema plan, pins the channel epoch, bootstraps the founder, loads
// a seed pack into an empty database, then serves `/__bolt/*` (shell host, then the protocol handler), `/hooks/*`,
// signed host operations and the artifact's client pages over node:http. Tenant work is admitted FIFO under one
// compute envelope; SIGTERM drains.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import {
	loadPackWithAssets,
	readArtifact,
	workspaceFiles,
	type Artifact
} from '@norbital-ai/bolt/artifact';
import {
	Authorities,
	BoltError,
	boltHandler,
	clientAddress,
	cloudflareTurnstile,
	devTurnstile,
	documentConverter,
	engine,
	fileAttachments,
	filesHandler,
	founderBootstrap,
	framePolicy,
	LIMITS,
	loadKeys,
	mint,
	openPglite,
	postgresDb,
	publicFetch,
	RateWindows,
	readPack,
	sealedSecrets,
	shellHost,
	signupOf,
	channelLinks,
	type Authority,
	type Bindings,
	type ChannelProvider,
	type Engine,
	type EngineManifest,
	type FilesPort,
	type IdentityHost,
	type Json,
	type PgPool,
	type TenantDb,
	type TransportPort
} from '@norbital-ai/bolt/engine';
import type { Config } from './config.ts';
import { mailTransport, messaging, type Sender } from './mail.ts';
import {
	aiModalityRefusals,
	facilities,
	localFiles,
	nominatim,
	openAi,
	publicWeb,
	s3Files,
	timekeeper
} from './ports.ts';
import { push } from './push.ts';
import {
	baileys,
	discord,
	mailbox,
	openRouterSpeech,
	slack,
	telegram,
	twilioWhatsapp,
	wechat
} from '@norbital-ai/providers';

export type StartOptions = {
	/** `bolt dev` / `--dev`: messaging printed to the log without `BOLT_TRANSACTIONAL_EMAIL` / `BOLT_TRANSACTIONAL_PHONE` and the fixed code, destructive steps accepted, the dev Turnstile (rules 38a(f), 69), connections to `*.localhost` (L-BOLT-366). */
	dev?: boolean;
	/** Replaces the host's mail (tests capture it). */
	mail?: Sender;
	/** The channel providers an administrator may choose at setup (default: every one `@norbital-ai/providers` ships; tests pass fakes). */
	channelProviders?: readonly ChannelProvider[];
	/** Contract digests this host implements (default: the engine's own); an artifact naming another is refused (§2.3 decision 5). */
	contracts?: readonly string[];
	/** The environment's compute envelope (rule 71): concurrent tenant invocations, FIFO beyond. */
	maxConcurrent?: number;
	/** The workspace clock (ISO instant) automations, cron slots, deadlines, `ctx.now` / `ctx.today` and the seed load read; default the wall clock (tests fix it). */
	clock?: () => string;
	fetch?: typeof fetch;
	log?: (line: string) => void;
};
export type Server = {
	url: string;
	engine: Engine;
	db: TenantDb;
	warnings: readonly string[];
	close(): Promise<void>;
};

export class ActivationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ActivationError';
	}
}

const DRAIN_MS = 10_000;
const JSON_BYTES = LIMITS.argsBytes + 1024 * 1024;
const TRANSPORTS = '/__bolt/transports/';

/** `readArtifact` refuses a contract this host does not implement and a manifest that is not the recorded schema (rule 69). */
function artifactOf(dir: string, contracts: readonly string[] | undefined): Artifact {
	try {
		return contracts === undefined ? readArtifact(dir) : readArtifact(dir, contracts);
	} catch (x) {
		throw new ActivationError(x instanceof Error ? x.message : String(x));
	}
}

/** Rule 69: what this workspace requires of the host, checked before anything is opened. */
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
	const local = c.local || o.dev === true;
	if (c.transactional?.email === undefined && o.mail === undefined && !local)
		errors.push(
			'mail is required for sign-in: set BOLT_TRANSACTIONAL_EMAIL (resend or sinch) and its keys'
		);
	if (signupOf(m)?.via.includes('phone') === true && c.transactional?.phone === undefined && !local)
		errors.push(
			'this workspace lets people sign up by mobile number: set BOLT_TRANSACTIONAL_PHONE (twilio or sinch) and its keys'
		);
	const env = (m.workspace.env ?? {}) as { readonly [n: string]: { secret?: boolean } };
	const oauth = Object.values(m.connections).some(
		(x) => typeof x['auth'] === 'object' && x['auth'] !== null && 'oauth2' in x['auth']
	);
	if (c.masterKey === null && (oauth || Object.values(env).some((d) => d.secret !== false)))
		errors.push('this workspace declares secrets: set BOLT_MASTER_KEY');
	const turnstile = Object.values(m.apps).some((a) =>
		JSON.stringify(a['audience'] ?? null).includes('"challenge":"turnstile"')
	);
	if (turnstile && c.turnstile === null && o.dev !== true)
		errors.push(
			'an app declares challenge: turnstile: set BOLT_TURNSTILE_SITE_KEY and BOLT_TURNSTILE_SECRET'
		);
	const ai = m.workspace.ai as
		{ models?: readonly string[]; embeddings?: readonly string[] } | undefined;
	const declared = [...(ai?.models ?? []), ...(ai?.embeddings ?? [])];
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
	const declaredTargets =
		(m.workspace as { convert?: { to?: readonly string[] } }).convert?.to ?? [];
	if (declaredTargets.length > 0 && c.providers.CONVERT === undefined)
		warnings.push(
			`this workspace converts to ${declaredTargets.join(', ')} but no converter is configured (BOLT_CONVERT_PROVIDER=norbital): those calls answer Unavailable`
		);
	// a channel's credentials are sealed in the secrets store, entered by an administrator at setup
	if (c.masterKey === null && Object.values(m.channels).some((x) => x['transport'] !== 'inbox'))
		warnings.push(
			'this workspace declares channels but BOLT_MASTER_KEY is not set: an administrator cannot connect them'
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

/** TLS unless the URL says `sslmode=disable` (§5.11.6): no `sslmode` means verified TLS; any given mode is the driver's to honour. */
export const pgOptions = (url: string) => ({
	connectionString: url,
	...(new URL(url).searchParams.has('sslmode') ? {} : { ssl: true }),
	max: 10
});

async function openDatabase(c: Config): Promise<{ db: TenantDb; close(): Promise<void> }> {
	if ('pglite' in c.database) {
		mkdirSync(c.database.pglite, { recursive: true }); // PGlite creates only the last segment
		const { db, pg } = await openPglite(c.database.pglite);
		return { db, close: () => pg.close() };
	}
	const { default: pg } = await import('pg');
	const pool = new pg.Pool(pgOptions(c.database.url));
	return { db: postgresDb(pool as unknown as PgPool), close: () => pool.end() };
}

/**
 * Rule 71: FIFO admission under `max`, request-path and platform work ahead of tenant automations. `drain(ms)` (rule
 * 71a) closes admission, sheds the waiters and resolves once nothing runs or `ms` passed, whichever is first.
 */
export function envelope(max: number) {
	let running = 0,
		closed = false;
	const lanes: [{ go(): void; shed(): void }[], { go(): void; shed(): void }[]] = [[], []];
	const idle: (() => void)[] = [];
	const next = () => {
		while (running < max) {
			const w = lanes[0].shift() ?? lanes[1].shift();
			if (w === undefined) break;
			running++;
			w.go();
		}
		if (running === 0) for (const done of idle.splice(0)) done();
	};
	const admit = async <T>(lane: 0 | 1, work: () => Promise<T>): Promise<T> => {
		if (closed) throw new BoltError('busy', 'admission', 'the server is draining');
		await new Promise<void>((go, shed) => {
			lanes[lane].push({
				go,
				shed: () => shed(new BoltError('busy', 'admission', 'the server is draining'))
			});
			next();
		});
		try {
			return await work();
		} finally {
			running--;
			next();
		}
	};
	return Object.assign(admit, {
		drain: (ms: number): Promise<boolean> => {
			closed = true;
			for (const w of [...lanes[0].splice(0), ...lanes[1].splice(0)]) w.shed();
			if (running === 0) return Promise.resolve(true);
			return new Promise<boolean>((done) => {
				const timer = setTimeout(() => done(false), ms);
				idle.push(() => {
					clearTimeout(timer);
					done(true);
				});
			});
		}
	});
}
/** Rule 71a: a bounded wait for what an interrupt already ended; nothing after SIGTERM waits unbounded. */
const within = (ms: number, work: Promise<unknown>): Promise<unknown> =>
	Promise.race([work.catch(() => undefined), new Promise((done) => setTimeout(done, ms).unref())]);

const MIME: { readonly [ext: string]: string } = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.wasm': 'application/wasm',
	'.txt': 'text/plain; charset=utf-8',
	'.webmanifest': 'application/manifest+json'
};
const err = (code: string, message: string, status: number) =>
	Response.json({ error: { code, message } }, { status });

export async function start(c: Config, o: StartOptions = {}): Promise<Server> {
	const log = o.log ?? ((line: string) => console.log(`[bolt] ${line}`));
	const f = o.fetch ?? fetch;
	const art = artifactOf(c.artifact, o.contracts);
	const m = art.manifest;
	const { errors, warnings } = requirements(c, m, o);
	if (errors.length > 0) throw new ActivationError(`activation refused:\n  ${errors.join('\n  ')}`);
	for (const w of warnings) log(`warning: ${w}`);

	const store = await openDatabase(c);
	const db = store.db;
	const release = art.artifact.hash.slice(0, 16);
	const { handle, name } = art.artifact;
	const files: FilesPort =
		c.files?.provider === 's3'
			? s3Files(c.files.endpoint, c.files.credential, f)
			: localFiles(c.files?.root ?? join(c.artifact, '.files'));
	const env = (m.workspace.env ?? {}) as {
		readonly [n: string]: { secret?: boolean; default?: string };
	};
	const secrets = sealedSecrets(db, c.masterKey, env);
	const admit = envelope(o.maxConcurrent ?? 8);
	let e: Engine | undefined;
	/** Rule 71a: the generation scope; SIGTERM aborts it after the grace, disposing every guest isolate. */
	const generation = new AbortController();
	const clock = o.clock ?? (() => new Date().toISOString());
	const deadlines = timekeeper(
		(scope) => admit(1, () => e!.runs!.tick()).then(() => log(`woke ${scope}`)),
		() => Date.parse(clock())
	);

	// optional providers (P19): absent → the port is absent
	const endpoint = (p: NonNullable<Config['providers']['AI_SYS_2']>) => ({
		endpoint: p.endpoint ?? 'https://api.openai.com/v1',
		credential: p.credential
	});
	// hook:ai — P39: every sys_2 and embed model takes images, or activation is refused
	const refused =
		c.providers.AI_SYS_2 === undefined
			? []
			: await aiModalityRefusals(
					[
						{
							system: 'sys_2',
							endpoint: endpoint(c.providers.AI_SYS_2),
							models: Object.values(c.ai.sys2),
							declared: c.ai.modalities.sys2
						},
						...(c.providers.AI_EMBED === undefined
							? []
							: [
									{
										system: 'embed' as const,
										endpoint: endpoint(c.providers.AI_EMBED),
										models: Object.values(c.ai.embed).map((x) =>
											typeof x === 'string' ? x : x.model
										),
										declared: c.ai.modalities.embed
									}
								])
					],
					f
				);
	if (refused.length > 0)
		throw new ActivationError(`activation refused:\n  ${refused.join('\n  ')}`);
	const ai =
		c.providers.AI_SYS_1 === undefined || c.providers.AI_SYS_2 === undefined
			? undefined
			: openAi(
					{
						sys1: { ...endpoint(c.providers.AI_SYS_1), provider: c.providers.AI_SYS_1.provider },
						sys2: endpoint(c.providers.AI_SYS_2),
						embed: c.providers.AI_EMBED === undefined ? undefined : endpoint(c.providers.AI_EMBED)
					},
					c.ai,
					[...((m.workspace.ai as { models?: string[] } | undefined)?.models ?? ['default'])],
					f
				);
	const geocoder =
		c.providers.GEO === undefined
			? undefined
			: nominatim(c.providers.GEO.endpoint ?? 'https://nominatim.openstreetmap.org', f);
	const web = c.providers.WEB === undefined ? undefined : publicWeb();
	// hook:convert — Norbital Convert, the open-source conversion service; unbound → no port
	const convert =
		c.providers.CONVERT?.endpoint === undefined || c.providers.CONVERT.credential === undefined
			? undefined
			: documentConverter({
					url: c.providers.CONVERT.endpoint,
					key: c.providers.CONVERT.credential
				});
	// `ctx.ai.transcribe` / `ctx.ai.speak`: OpenRouter, each capability only with its model; ffmpeg on PATH splits long audio
	const speech =
		c.speech === null
			? undefined
			: openRouterSpeech(
					{
						apiKey: c.speech.credential,
						baseUrl: c.speech.endpoint,
						...(c.speech.transcribe === null ? {} : { transcribeModel: c.speech.transcribe }),
						...(c.speech.speak === null ? {} : { speakModel: c.speech.speak }),
						...(c.speech.voice === null ? {} : { speakVoice: c.speech.voice })
					},
					f
				);
	const workspace = workspaceFiles(art.dir); // the released source and its type index (`workspace_read`, `workspace_type`)
	const hosted = messaging(c, log, f, c.local || o.dev === true, o.dev === true);
	const email = mailTransport(o.mail ?? hosted.email!.send); // requirements refused a start without mail
	// channels (rule 61): one link per declared channel, from the provider and credentials an administrator chose at setup,
	// sealed in the secrets store (owner `transport`). No channel reads host env or rides on the host's mail.
	const links = channelLinks({
		manifest: m,
		providers: o.channelProviders ?? [
			baileys(),
			twilioWhatsapp(),
			telegram(),
			slack(),
			discord(),
			wechat(),
			...mailbox()
		],
		load: async (channel) => {
			const v = await secrets.use('transport', channel);
			return v === null ? null : (JSON.parse(v) as Json);
		},
		store: (channel, sealed) =>
			sealed === null
				? secrets.clear('transport', channel)
				: secrets.set('transport', channel, JSON.stringify(sealed)),
		webhookUrl: (channel, transport) =>
			new URL(`/hooks/bolt.${transport}/${encodeURIComponent(channel)}`, c.publicUrl).href,
		fetch: f,
		log
	});
	const pusher = c.vapid === null ? undefined : push(db, c.vapid, c.publicUrl);
	const transports: { readonly [t: string]: TransportPort } = {
		...links.transports,
		...(pusher === undefined ? {} : { push: pusher })
	};

	try {
		// the channel epoch (rule 61): minted once per database, so a restart keeps sending what it queued
		const pack = c.seed === null ? null : readPack(resolve(c.seed));
		const engineOf = (epoch: string) =>
			engine({
				manifest: m,
				db,
				guest: art.guest,
				transforms: art.transforms,
				agent: {
					attachments: fileAttachments(db, files),
					...(workspace === undefined ? {} : { workspace }),
					...(geocoder === undefined ? {} : { geocoder }),
					...(web === undefined ? {} : { web })
				},
				console: (level: string, ...args: unknown[]) =>
					log(
						`guest ${level}: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
					),
				deadlines,
				clock,
				scope: handle,
				files,
				...(convert === undefined ? {} : { convert }),
				...(speech === undefined ? {} : { speech }),
				connections: {
					secrets,
					publicUrl: c.publicUrl,
					// L-BOLT-366: a dev host's connections may reach a provider on this machine; any other host gets the engine's guard
					...(o.fetch !== undefined
						? { fetch: o.fetch }
						: o.dev === true
							? { fetch: publicFetch({ allowLoopback: true }) }
							: {})
				},
				epoch,
				transports,
				...(ai === undefined ? {} : { ai }), // hook:ai
				runs: {
					facility: facilities({
						...(ai === undefined ? {} : { ai }),
						...(geocoder === undefined ? {} : { geocoder }),
						...(web === undefined ? {} : { web }),
						files,
						db
					}),
					env: secrets.env,
					eventRetainHours: c.telemetryRetainHours,
					...(pack === null ? {} : { start: pack.meta.start })
				},
				envoys: { workspace: name },
				signal: generation.signal
			} as Parameters<typeof engine>[0]);
		const probe = engineOf('');
		try {
			await probe.migrate(c.accept || o.dev === true ? { accept: true } : {});
		} catch (x) {
			throw x instanceof BoltError && x.code === 'destructiveNotAccepted'
				? new ActivationError(`${x.message}; start with --accept`)
				: x;
		}
		const [ep] = await db.read([
			{ text: `SELECT value FROM sys_config WHERE key = 'channels.epoch'`, params: [] }
		]);
		e = engineOf(String(ep!.rows[0]?.['value'] ?? randomUUID()));
		await e.channels.activate();
		const unsubscribe = [
			e.channels.subscribe(),
			e.integrations.subscribe(Object.values(transports), randomUUID)
		];
		await secrets.load();

		const now = () => new Date();
		const keys = await loadKeys(db);
		const signup = signupOf(m);
		const identity: IdentityHost = {
			db,
			now,
			windows: new RateWindows(),
			keys,
			mail: email,
			...(hosted.sms === undefined ? {} : { sms: hosted.sms }),
			...(hosted.phone === undefined ? {} : { phone: hosted.phone }),
			...(signup === undefined ? {} : { signup }),
			devSink: o.dev === true,
			publicUrl: c.publicUrl
		};
		const authorities = new Authorities(m, release);

		if (pack !== null)
			log(
				(await loadPackWithAssets(db, m, pack, files, clock()))
					? `--seed: loaded pack ${pack.meta.name} (${pack.meta.hash.slice(0, 12)})`
					: '--seed: the database has rows; nothing seeded'
			);
		if (c.founder !== null) {
			const [admins] = await db.read([
				{ text: `SELECT 1 FROM sys_user WHERE admin LIMIT 1`, params: [] }
			]);
			if (admins!.rows.length === 0) {
				const r = await founderBootstrap(identity, c.founder);
				log(
					r.ok
						? `--founder: ${c.founder} is the administrator; sign in with the code sent to it`
						: `--founder: ${r.message}`
				);
			}
		}
		await e.runs!.boot();
		await links.resume();

		const peers = new WeakMap<Request, string>();
		const shell = shellHost({
			manifest: m,
			identity,
			authorities,
			workspace: { name, handle },
			ip: (r) => peers.get(r) ?? '0.0.0.0',
			runs: e.runs!,
			secure: new URL(c.publicUrl).protocol === 'https:',
			ai: ai !== undefined,
			...(c.environment === null ? {} : { environment: c.environment }),
			turnstile:
				c.turnstile !== null
					? cloudflareTurnstile(c.turnstile.siteKey, c.turnstile.secret, f)
					: devTurnstile,
			secrets: { status: secrets.status, set: secrets.set, clear: secrets.clear },
			...(e.connections === undefined ? {} : { connections: e.connections }),
			...(c.vapid === null ? {} : { push: { publicKey: c.vapid.publicKey } })
		});
		const bindings = (): Bindings => {
			const n = now().toISOString();
			return { now: n, today: n.slice(0, 10), tz: m.workspace.tz, params: {} };
		};
		const protocol = boltHandler({
			engine: e,
			session: shell.authority,
			bindings,
			uuid: randomUUID
		});
		const fileRoute = filesHandler({ engine: e, session: shell.authority, bindings });
		const engineRef = e;

		/** `POST /__bolt/ops` (§7.1 MAC over v1 · env · host · op · ts · nonce · sha256(body); single-use nonce and runId). */
		async function ops(request: Request): Promise<Response> {
			if (c.opsKey === null)
				return err('unavailable', 'host operations are not configured (BOLT_OPS_KEY)', 503);
			const body = new Uint8Array(await request.arrayBuffer());
			const ts = request.headers.get('bolt-op-ts') ?? '',
				nonce = request.headers.get('bolt-op-nonce') ?? '',
				mac = request.headers.get('bolt-op-mac') ?? '';
			let x: { op?: unknown; input?: { [k: string]: Json }; runId?: unknown };
			try {
				x = JSON.parse(new TextDecoder().decode(body)) as typeof x;
			} catch {
				return err('invalid', 'the body is not JSON', 400);
			}
			const op = String(x.op ?? '');
			const want = createHmac('sha256', c.opsKey)
				.update(
					[
						'v1',
						handle,
						new URL(c.publicUrl).host,
						op,
						ts,
						nonce,
						createHash('sha256').update(body).digest('hex')
					].join('\n')
				)
				.digest();
			const got = Buffer.from(mac, 'base64url');
			if (
				got.length !== want.length ||
				!timingSafeEqual(got, want) ||
				!/^[\w-]{16,}$/.test(nonce) ||
				Math.abs(Date.now() - Number(ts)) > 300_000
			)
				return err('forbidden', 'the operation is not signed', 403);
			const once = [`nonce:${nonce}`, ...(typeof x.runId === 'string' ? [`run:${x.runId}`] : [])];
			const fresh = await db.write({
				text: `INSERT INTO bolt_host_nonce (key, at) SELECT k, now() FROM jsonb_array_elements_text($1::jsonb) k ON CONFLICT (key) DO NOTHING RETURNING key`,
				params: [JSON.stringify(once)]
			});
			if (fresh.rows.length !== once.length)
				return err('replayed', 'the nonce or run was already used', 409);
			const input = x.input ?? {};
			const answer = (r: Awaited<ReturnType<typeof mint>>) =>
				r.ok
					? Response.json({ value: r.value })
					: err(r.code, r.message, r.code === 'notFound' ? 404 : 403);
			if (op === 'host.ping')
				return Response.json({ value: { workspace: handle, at: now().toISOString() } }); // L-BOLT-298: the host answers signed operations
			if (op === 'session.mint' && typeof input['user'] === 'string')
				return answer(await mint(identity, input['user']));
			if (op === 'founder.bootstrap' && typeof input['address'] === 'string')
				return answer(
					await founderBootstrap(
						identity,
						input['address'],
						typeof input['name'] === 'string' ? input['name'] : undefined
					)
				);
			return err('unknownOp', `'${op}' is not a host operation of bolt start`, 404);
		}

		/**
		 * A channel's connection, for an administrator: `GET` the state (or the SSE stream of it), `POST …/pair`, `POST
		 * `…/logout`. The path names the *channel* and the answer is always the one `ChannelConnection` (`connection.ts`),
		 * so the shell's connect component is the same for every provider — including one this host has no adapter for,
		 * which answers Unavailable rather than a state that would read as connected.
		 */
		async function transportRoute(
			request: Request,
			auth: Authority | null,
			path: string
		): Promise<Response> {
			if (auth === null || auth.actor.kind !== 'member' || auth.actor.external)
				return err(
					'forbidden',
					'Sign in as an internal workspace member to manage channel accounts.',
					403
				);
			const [name = '', verb = ''] = path.slice(TRANSPORTS.length).split('/');
			return links.admin(request, decodeURIComponent(name), verb, auth);
		}

		async function hooks(request: Request, path: string): Promise<Response> {
			// a channel's own webhook, `/hooks/bolt.<transport>/<channel>[/…]` (an OAuth callback, a tracking pixel under it): the link checks it
			const hook = /^\/hooks\/bolt\.([a-z]+)\/([^/]+)(?:\/.*)?$/.exec(path);
			if (hook !== null && links.transportOf(decodeURIComponent(hook[2]!)) === hook[1])
				return links.webhook(decodeURIComponent(hook[2]!), request);
			const url = new URL(request.url);
			const r = await engineRef.runs!.webhook(path.slice('/hooks'.length), {
				method: request.method,
				headers: Object.fromEntries(request.headers),
				body: new Uint8Array(await request.arrayBuffer()),
				query: Object.fromEntries(url.searchParams)
			} as Parameters<NonNullable<Engine['runs']>['webhook']>[1]);
			return new Response(r.body ?? null, { status: r.status });
		}

		const client = resolve(art.client),
			artifactDir = resolve(art.dir);
		/** A file under `base`, or undefined (never outside it). */
		const under = async (base: string, path: string) => {
			const file = resolve(base, `.${decodeURIComponent(path)}`);
			return file.startsWith(base + sep) &&
				(await stat(file).then(
					(s) => s.isFile(),
					() => false
				))
				? file
				: undefined;
		};
		/** The client build, then the artifact's workspace `assets/**` at `/assets/*`, then the document. */
		async function page(path: string): Promise<Response> {
			const hit =
				(await under(client, path)) ??
				(path.startsWith('/assets/') ? await under(artifactDir, path) : undefined) ??
				join(client, 'index.html');
			if (!existsSync(hit))
				return new Response('This artifact carries no client pages.', { status: 404 });
			const doc = hit.endsWith('index.html');
			return new Response(await readFile(hit), {
				headers: {
					'content-type': MIME[extname(hit)] ?? 'application/octet-stream',
					'cache-control': doc ? 'no-cache' : 'public, max-age=31536000, immutable',
					...(doc ? { 'content-security-policy': framePolicy(m, path) } : {})
				}
			});
		}

		async function route(request: Request): Promise<Response> {
			const path = new URL(request.url).pathname;
			if (path.startsWith('/hooks/')) return admit(0, () => hooks(request, path));
			if (path === '/__bolt/ops' && request.method === 'POST') return ops(request);
			if (path.startsWith(TRANSPORTS))
				return transportRoute(request, await shell.authority(request), path);
			const own = await shell.handle(request);
			if (own !== null) return own;
			if (!path.startsWith('/__bolt/'))
				return request.method === 'GET' || request.method === 'HEAD'
					? page(path)
					: err('notFound', 'no such route', 404);
			if (path.startsWith('/__bolt/files/'))
				return admit(0, async () => (await fileRoute(request))!);
			const live = path === '/__bolt/live' && request.method === 'GET';
			const r = live ? await protocol(request) : await admit(0, () => protocol(request));
			return r ?? err('notFound', 'no such route', 404);
		}

		// ── node:http ↔ fetch ──
		/** Open SSE bodies: a drain ends them at once (their clients reconnect elsewhere), everything else finishes. */
		const streams = new Set<() => void>();
		let draining = false;
		const server = createServer((req, res) => void serve(req, res));
		async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
			// while draining, a connection whose response finished is idle: close it rather than wait out keep-alive
			res.on('finish', () => {
				if (draining) setImmediate(() => server.closeIdleConnections());
			});
			try {
				// every absolute URL is built from BOLT_PUBLIC_URL, never Host (GAPS r5 3)
				const url = new URL(req.url ?? '/', c.publicUrl);
				const limit =
					req.method === 'PUT' && url.pathname.startsWith('/__bolt/files/')
						? LIMITS.storedFileBytes
						: JSON_BYTES;
				const chunks: Buffer[] = [];
				let size = 0;
				if (req.method !== 'GET' && req.method !== 'HEAD')
					for await (const chunk of req as AsyncIterable<Buffer>) {
						size += chunk.length;
						if (size > limit) {
							res
								.writeHead(413, { 'content-type': 'application/json' })
								.end(
									JSON.stringify({
										error: { code: 'tooLarge', message: `the body is over ${limit} bytes` }
									})
								);
							return;
						}
						chunks.push(chunk);
					}
				const headers = new Headers();
				for (const [k, v] of Object.entries(req.headers))
					if (v !== undefined) for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
				const request = new Request(url, {
					method: req.method ?? 'GET',
					headers,
					...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) })
				});
				peers.set(
					request,
					clientAddress(
						req.socket.remoteAddress ?? '0.0.0.0',
						req.headers['x-forwarded-for']?.toString(),
						c.trustProxy
					)
				);
				let response: Response;
				try {
					response = await route(request);
				} catch (x) {
					log(
						`error ${req.method} ${url.pathname}: ${x instanceof Error ? (x.stack ?? x.message) : String(x)}`
					);
					response = err('internal', 'The request failed.', 500);
				}
				const out: { [k: string]: string | string[] } = {};
				response.headers.forEach((v, k) => {
					if (k !== 'set-cookie') out[k] = v;
				});
				const cookies = response.headers.getSetCookie();
				if (cookies.length > 0) out['set-cookie'] = cookies;
				res.writeHead(response.status, out);
				if (response.body === null || req.method === 'HEAD') {
					res.end();
					return;
				}
				const reader = response.body.getReader();
				const cancel = () => void reader.cancel().catch(() => undefined);
				res.on('close', cancel);
				if (response.headers.get('content-type') === 'text/event-stream') streams.add(cancel);
				res.flushHeaders();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						res.write(value);
					}
				} finally {
					streams.delete(cancel);
				}
				res.end();
			} catch (x) {
				if (!res.headersSent) res.writeHead(500).end();
				else res.destroy(x instanceof Error ? x : undefined);
			}
		}
		await new Promise<void>((ok_, fail) => {
			server.once('error', fail);
			server.listen(c.port, c.host, () => {
				server.off('error', fail);
				ok_();
			});
		});
		const address = server.address();
		const url = `http://${c.host.includes(':') ? `[${c.host}]` : c.host}:${typeof address === 'object' && address !== null ? address.port : c.port}`;
		log(`serving ${name} (${release}) on ${url} as ${c.publicUrl}`);

		let closing: Promise<void> | undefined;
		return {
			url,
			engine: e,
			db,
			warnings,
			// rule 71a: SIGTERM stops admission (the listener, the timekeeper, the envelope), waits at most DRAIN_MS for
			// what runs, then interrupts the rest (isolates disposed, facility calls aborted; an interrupted run is re-queued
			// as a lost lease on the next start); every later wait is bounded
			close: () =>
				(closing ??= (async () => {
					const stopped = new Promise<void>((done) => server.close(() => done()));
					draining = true;
					deadlines.stop();
					server.closeIdleConnections();
					for (const cancel of streams) cancel();
					const deadline = Date.now() + DRAIN_MS;
					const drained = await Promise.race([
						stopped.then(() => true),
						new Promise<boolean>((done) => setTimeout(() => done(false), DRAIN_MS).unref())
					]);
					const idle = await admit.drain(Math.max(0, deadline - Date.now()));
					if (!drained) server.closeAllConnections();
					if (!idle) log('drain: the grace passed with work running; interrupting it');
					generation.abort();
					await within(500, links.close());
					for (const off of unsubscribe) off();
					await within(500, engineRef.envoys.settled());
					await within(500, store.close());
					log('stopped');
				})())
		};
	} catch (x) {
		generation.abort();
		deadlines.stop();
		await links.close();
		await store.close().catch(() => undefined);
		throw x;
	}
}
