// Norbital Convert: Markdown or HTML to pdf, docx, pptx, odt, epub or html over HTTP, behind API keys.
//
//   POST /v1/convert            { from, to, source, page?, landscape?, reference? } → Server-Sent Events: the job on
//                               every change, then `event: result` { mime, to, bytes (base64) } once it succeeds
//   POST /v1/convert/preview    transient PDF response with no job, result record, or shared-volume write
//   POST /v1/jobs               the same body → 202 job, for callers that watch or fetch later
//   GET  /v1/jobs/:id           the job
//   GET  /v1/jobs/:id/events    the job's events, closed once it settles; `?result` streams the result too (a
//                               /v1/convert whose connection dropped resumes here: the job lives on in the queue)
//   GET  /v1/jobs/:id/result    the converted bytes
//   POST /v1/ingest             { name, mime, bytes (base64), options? } → the same stream; `event: result` is the
//                               parse ({ kind: 'document', html, images } or { kind: 'data', json, images })
//                               with the job's own meta: { usage?, stats }; also
//                               POST /v1/jobs { op: 'ingest', … } → 202 job
//   POST /v1/ingest/raw         ?name&mime&options&sha256&lane, the file as the body → 202 job; with sha256 a PDF stays an
//                               hour past its last read and a kept one's body is not needed; `lane` (a tenant) is
//                               what claims stay fair across; `x-ingest-password` (base64 of its UTF-8) opens a locked
//                               PDF or Office file. The job row holds it until the job is pruned
//   GET  /v1/kept/:sha256       200 while that file is kept, 404 when it must be sent
//   GET  /healthz               unauthenticated liveness and queue depth
//
// Every replica serves every route and pulls from the shared queue, so any load balancer in front spreads the HTTP and
// the queue spreads the work. A key sees only the jobs it submitted. A burst waits in the queue on the disk: this server
// holds no file and no answer, and each ingest runs in a process of its own (job.ts). It refuses only when the volume is
// nearly full.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	utimesSync
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { availableParallelism, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
	Cause,
	Clock,
	Context,
	Effect,
	Fiber,
	FiberSet,
	Layer,
	ManagedRuntime,
	Result,
	Schedule,
	Schema
} from 'effect';
import {
	PAPER,
	STYLED,
	TARGETS,
	pandoc,
	type Converter,
	type Request,
	type Target
} from './convert.ts';
import type { Reads } from './job.ts';
import { spawned } from './job.ts';
import { layoutPdf } from './layout-pdf.ts';
import { openQueue, type Job } from './queue.ts';
import { route } from './route.ts';

export type Options = {
	keys: readonly string[];
	database: string;
	convert: Converter;
	ingest?: Reads;
	/** The ingester transcribes audio; without it audio answers 503. */
	transcribes?: boolean;
	concurrency?: number;
	maxQueued?: number;
	maxBytes?: number;
	maxIngestBytes?: number;
	retainMs?: number;
	pollMs?: number;
	/** Free space on the volume below which new files are refused. */
	reserveBytes?: number;
};

/** A replica renews its leases every LEASE_MS / 3, so a dead one's jobs run elsewhere within LEASE_MS. */
const LEASE_MS = 15_000;
/** Lease rounds between sweeps of the spool: a burst's many files are not walked every few seconds. */
const SWEEP_EVERY = 60;
/** A watcher's check; a job this replica runs wakes it sooner. */
const WATCH_MS = 1000;
const PREVIEW_BYTES = 8 * 1024 * 1024;
const digest = (s: string) => createHash('sha256').update(s).digest();
const settled = (j: Job) => j.state === 'succeeded' || j.state === 'failed';
const TargetSchema = Schema.declare(
	(value: unknown): value is Target => typeof value === 'string' && Object.hasOwn(TARGETS, value)
);
const PaperSchema = Schema.declare(
	(value: unknown): value is keyof typeof PAPER =>
		typeof value === 'string' && Object.hasOwn(PAPER, value)
);
const StoredRequest = Schema.fromJsonString(
	Schema.Struct({
		from: Schema.Literals(['markdown', 'html', 'layout-html']),
		to: TargetSchema,
		source: Schema.NonEmptyString,
		page: Schema.optionalKey(PaperSchema),
		landscape: Schema.optionalKey(Schema.Boolean)
	}).check(
		Schema.makeFilter((request) => {
			if (request.to === 'pdf') return;
			if (request.from === 'layout-html') return 'Layout HTML requires PDF';
			if (request.page !== undefined || request.landscape !== undefined)
				return 'page and landscape are PDF options';
		})
	)
);
const AudioOptions = Schema.Struct({
	diarize: Schema.optionalKey(Schema.Boolean),
	language: Schema.optionalKey(Schema.String),
	speakers: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
	prompt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
	pictures: Schema.optionalKey(Schema.Boolean),
	page: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
	/** A locked PDF's or Office file's password: on the raw route its header, never the URL a log keeps. */
	password: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255)))
});
const StoredIngest = Schema.fromJsonString(
	Schema.Struct({
		op: Schema.Literal('ingest'),
		name: Schema.String,
		mime: Schema.String,
		options: Schema.optionalKey(AudioOptions),
		spool: Schema.String
	})
);
const IngestBody = Schema.Struct({
	op: Schema.optionalKey(Schema.Literal('ingest')),
	name: Schema.NonEmptyString,
	mime: Schema.String,
	bytes: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/=\s]*$/)),
	options: Schema.optionalKey(AudioOptions)
});
const isIngest = Schema.is(Schema.Struct({ op: Schema.Literal('ingest') }));
class HttpFailed extends Schema.TaggedError<HttpFailed>()('HttpFailed', {
	status: Schema.Literals([400, 413, 500]),
	message: Schema.String
}) {}
class CloseFailed extends Schema.TaggedError<CloseFailed>()('CloseFailed', {
	message: Schema.String
}) {}
const httpFailed = (cause: unknown) =>
	new HttpFailed({
		status: cause instanceof RangeError ? 413 : cause instanceof SyntaxError ? 400 : 500,
		message: cause instanceof Error ? cause.message : String(cause)
	});
const Work = Context.Service<{
	readonly conversions: FiberSet.FiberSet<void, never>;
	readonly requests: FiberSet.FiberSet<void, never>;
	readonly maintenance: FiberSet.FiberSet<void, never>;
}>('convert/Work');
export function service(o: Options) {
	const {
		concurrency = availableParallelism(),
		maxQueued = 100_000,
		maxBytes = 20 * 1024 * 1024,
		maxIngestBytes = 2 * 1024 * 1024 * 1024,
		retainMs = 3_600_000,
		pollMs = 500,
		reserveBytes = 1024 ** 3
	} = o;
	if (o.keys.length === 0) throw new Error('CONVERT_API_KEYS names no key.');
	const keys = o.keys.map(digest);
	const queue = openQueue(o.database);
	/** Beside the queue on the volume every replica mounts: a raw file waits here for its job, at any size. */
	const spool = join(dirname(o.database), 'spool');
	/** Every answer, a file by its job's id: a queue row holds what a job is, never its bytes. */
	const results = join(dirname(o.database), 'results');
	mkdirSync(spool, { recursive: true });
	mkdirSync(results, { recursive: true });
	const roomy = () => {
		const { bavail, bsize } = statfsSync(spool);
		return bavail * bsize >= reserveBytes;
	};
	const keptPath = (who: string, sha256: string) => join(spool, `kept-${who}-${sha256}`);
	const unspool = (claimed: { readonly request: string }) => {
		const ingest = Schema.decodeUnknownResult(StoredIngest)(claimed.request);
		if (
			Result.isSuccess(ingest) &&
			ingest.success.spool !== undefined &&
			!basename(ingest.success.spool).startsWith('kept-')
		)
			rmSync(ingest.success.spool, { force: true });
	};
	const runtime = ManagedRuntime.make(
		Layer.effect(
			Work,
			Effect.gen(function* () {
				return {
					conversions: yield* FiberSet.make<void, never>(),
					requests: yield* FiberSet.make<void, never>(),
					maintenance: yield* FiberSet.make<void, never>()
				};
			})
		)
	);
	const run = runtime.runSync(
		Effect.gen(function* () {
			const work = yield* Work;
			return {
				conversion: yield* FiberSet.runtime(work.conversions)<never>(),
				request: yield* FiberSet.runtime(work.requests)<never>(),
				maintenance: yield* FiberSet.runtime(work.maintenance)<never>()
			};
		})
	);
	const worker = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
	let active = 0,
		stopping = false;
	/** Watchers on this replica, woken when a job it runs changes; the 250 ms poll covers the other replicas' jobs. */
	const watchers = new Set<() => void>();
	const changed = () => watchers.forEach((w) => w());

	/** Fills this replica's free slots from the queue. */
	function pump() {
		while (!stopping && active < concurrency) {
			const claimed = queue.claim(worker, LEASE_MS);
			if (!claimed) return;
			active++;
			changed();
			const conversion = Effect.gen(function* () {
				const out = join(results, claimed.id),
					ingest = Schema.decodeUnknownResult(StoredIngest)(claimed.request);
				if (Result.isSuccess(ingest)) {
					if (!o.ingest) return yield* Effect.fail(new Error('This replica does not ingest.'));
					const { spool: path, op: _, ...asked } = ingest.success;
					yield* o.ingest({ ...asked, path, out });
					return { mime: 'application/json' };
				}
				const request = yield* Schema.decodeUnknownEffect(StoredRequest)(claimed.request);
				const result = yield* o.convert(request, claimed.reference);
				yield* Effect.tryPromise(() => writeFile(out, result));
				return { mime: TARGETS[request.to] };
			});
			run.conversion(
				conversion.pipe(
					Effect.matchCauseEffect({
						onSuccess: (outcome) =>
							Effect.sync(() => {
								queue.finish(claimed.id, worker, outcome);
								unspool(claimed);
							}),
						onFailure: (cause) =>
							Effect.sync(() => {
								const error = Cause.squash(cause);
								queue.finish(claimed.id, worker, {
									error: error instanceof Error ? error.message : String(error)
								});
								unspool(claimed);
							})
					}),
					Effect.ensuring(
						Effect.sync(() => {
							active--;
							changed();
							pump();
						})
					)
				)
			);
		}
	}
	let sweeps = 0;
	const claiming = run.maintenance(
		Effect.sync(pump).pipe(
			Effect.repeat(Schedule.spaced(pollMs)),
			Effect.asVoid,
			Effect.delay(pollMs)
		)
	);
	const leases = run.maintenance(
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			yield* Effect.sync(() => {
				queue.renew(worker, LEASE_MS);
				queue.recover();
				for (const id of queue.purge(now - retainMs)) rmSync(join(results, id), { force: true });
				// a replica that died mid-job left its file, and the job's retention has passed
				if (++sweeps % SWEEP_EVERY === 0)
					for (const name of readdirSync(spool)) {
						const file = join(spool, name);
						if (statSync(file).mtimeMs < now - retainMs) rmSync(file, { force: true });
					}
			});
		}).pipe(Effect.repeat(Schedule.spaced(LEASE_MS / 3)), Effect.asVoid, Effect.delay(LEASE_MS / 3))
	);

	/** The caller's key as its owner id, or undefined; each key is compared in constant time. */
	function owner(req: IncomingMessage) {
		const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
		if (!m) return undefined;
		const d = digest(m[1]!);
		return keys.some((k) => timingSafeEqual(k, d)) ? d.toString('hex').slice(0, 32) : undefined;
	}

	const send = (
		res: ServerResponse,
		status: number,
		body: unknown,
		headers: Record<string, string> = {}
	) =>
		res
			.writeHead(status, { 'content-type': 'application/json', ...headers })
			.end(JSON.stringify(body));

	const bytesOf = (req: IncomingMessage, limit: number) =>
		Effect.callback<Buffer, HttpFailed>((resume) => {
			const chunks: Buffer[] = [];
			let size = 0;
			const cleanup = () => {
				req.off('data', data);
				req.off('end', end);
				req.off('error', error);
				req.off('aborted', aborted);
			};
			const error = (cause: Error) => {
				cleanup();
				resume(Effect.fail(httpFailed(cause)));
			};
			const aborted = () => {
				cleanup();
				resume(Effect.fail(new HttpFailed({ status: 500, message: 'aborted' })));
			};
			const data = (chunk: Buffer) => {
				size += chunk.length;
				if (size > limit) {
					cleanup();
					req.resume();
					resume(
						Effect.fail(
							new HttpFailed({
								status: 413,
								message: `The request is larger than ${limit} bytes.`
							})
						)
					);
				} else chunks.push(chunk);
			};
			const end = () => {
				cleanup();
				resume(Effect.succeed(Buffer.concat(chunks)));
			};
			req.on('data', data);
			req.once('end', end);
			req.once('error', error);
			req.once('aborted', aborted);
			return Effect.sync(() => {
				cleanup();
				req.destroy();
			});
		});
	const body = (req: IncomingMessage, limit: number) =>
		bytesOf(req, limit).pipe(
			Effect.flatMap((bytes) =>
				Effect.try({
					try: (): unknown => JSON.parse(bytes.toString('utf8')),
					catch: httpFailed
				})
			)
		);

	function parse(b: unknown): { request: Request; reference: Uint8Array | null } | string {
		const object = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Unknown))(b);
		if (Result.isFailure(object)) return 'The body is a JSON object.';
		const { from, to, source, page, landscape, reference } = object.success;
		if (from !== 'markdown' && from !== 'html' && from !== 'layout-html')
			return "from is 'markdown', 'html' or 'layout-html'.";
		if (!Schema.is(TargetSchema)(to)) return `to is one of ${Object.keys(TARGETS).join(', ')}.`;
		if (typeof source !== 'string' || source === '')
			return 'source is the non-empty document text.';
		const target = to;
		if (from === 'layout-html' && target !== 'pdf') return 'Layout HTML requires PDF.';
		if (page !== undefined && (target !== 'pdf' || !Schema.is(PaperSchema)(page)))
			return `page is a pdf's, one of ${Object.keys(PAPER).join(', ')}.`;
		if (landscape !== undefined && (target !== 'pdf' || typeof landscape !== 'boolean'))
			return "landscape is a pdf's, true or false.";
		if (reference !== undefined && (!STYLED.includes(target) || typeof reference !== 'string'))
			return `reference is base64 of a ${STYLED.join(', ')} that styles one.`;
		return {
			request: {
				from,
				to: target,
				source,
				...(page === undefined ? {} : { page }),
				...(landscape === undefined ? {} : { landscape })
			},
			reference: typeof reference === 'string' ? Buffer.from(reference, 'base64') : null
		};
	}

	function watch(
		req: IncomingMessage,
		res: ServerResponse,
		who: string,
		id: string,
		withResult: boolean
	) {
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			'x-accel-buffering': 'no'
		});
		let last = '';
		const close = () => {
			watchers.delete(check);
			clearInterval(tick);
			clearInterval(ping);
			res.end();
		};
		const check = () => {
			const job = queue.get(who, id);
			if (!job) return close();
			const text = JSON.stringify(job);
			if (text !== last) res.write(`event: job\ndata: ${(last = text)}\n\n`);
			if (!settled(job)) return;
			const out = withResult ? queue.result(who, id) : undefined;
			if (!out) return close();
			watchers.delete(check);
			clearInterval(tick);
			void readFile(join(results, id)).then((bytes) => {
				res.write(
					`event: result\ndata: ${out.target === 'ingest' ? bytes.toString('utf8') : JSON.stringify({ mime: out.mime, to: out.target, bytes: bytes.toString('base64') })}\n\n`
				);
				close();
			}, close);
		};
		watchers.add(check);
		const tick = setInterval(check, WATCH_MS),
			ping = setInterval(() => res.write(': ping\n\n'), 15_000);
		res.on('close', close);
		check();
	}

	const server = createServer((req, res) => {
		run.request(
			Effect.gen(function* () {
				const url = new URL(req.url ?? '/', 'http://convert');
				if (req.method === 'GET' && url.pathname === '/healthz')
					return send(res, stopping ? 503 : 200, {
						ok: !stopping,
						queued: queue.depth(),
						running: active
					});
				const who = owner(req);
				if (!who)
					return send(
						res,
						401,
						{ error: 'An API key is required: Authorization: Bearer <key>.' },
						{ 'www-authenticate': 'Bearer' }
					);
				if (req.method === 'POST' && url.pathname === '/v1/convert/preview') {
					if (stopping) return send(res, 503, { error: 'This replica is shutting down.' });
					const parsed = parse(yield* body(req, maxBytes));
					if (typeof parsed === 'string') return send(res, 400, { error: parsed });
					if (parsed.request.to !== 'pdf') return send(res, 400, { error: 'Preview requires PDF.' });
					if (res.destroyed) return;
					if (stopping) return send(res, 503, { error: 'This replica is shutting down.' });
					if (active >= concurrency || queue.depth() > 0)
						return send(res, 429, { error: 'The converter is busy.' }, { 'retry-after': '5' });
					active++;
					const disconnected = Effect.callback<void>((resume) => {
						const close = () => resume(Effect.void);
						res.once('close', close);
						return Effect.sync(() => { res.off('close', close); });
					});
					yield* o.convert(parsed.request, parsed.reference).pipe(
						Effect.tap((bytes) => Effect.sync(() => {
							if (bytes.byteLength > PREVIEW_BYTES)
								return send(res, 413, { error: 'The PDF is too large.' });
							res.writeHead(200, {
								'content-type': 'application/pdf',
								'content-length': String(bytes.byteLength),
								'cache-control': 'private, no-store'
							}).end(bytes);
						})),
						Effect.raceFirst(disconnected),
						Effect.ensuring(Effect.sync(() => { active--; pump(); }))
					);
					return;
				}
				const keptFile = /^\/v1\/kept\/([0-9a-f]{64})$/.exec(url.pathname);
				if (req.method === 'GET' && keptFile) {
					const kept = keptPath(who, keptFile[1]!);
					if (!existsSync(kept)) return send(res, 404, { error: 'not kept' });
					const now = new Date();
					utimesSync(kept, now, now);
					return send(res, 200, { kept: true });
				}
				// a file as the body, for a job: base64 in JSON cannot hold one past a few hundred MiB
				if (req.method === 'POST' && url.pathname === '/v1/ingest/raw') {
					if (stopping) return send(res, 503, { error: 'This replica is shutting down.' });
					if (queue.depth() >= maxQueued || !roomy())
						return send(res, 429, { error: 'The queue is full.' }, { 'retry-after': '30' });
					const name = url.searchParams.get('name') ?? '',
						mime = url.searchParams.get('mime') ?? '',
						options = url.searchParams.get('options'),
						password = req.headers['x-ingest-password'],
						asked = Schema.decodeUnknownSync(AudioOptions)({
							...(options === null ? {} : JSON.parse(options)),
							...(typeof password === 'string' ? { password: Buffer.from(password, 'base64').toString('utf8') } : {})
						}),
						where = route(name, mime);
					if (!where.ok) return send(res, 415, { error: 'unsupported', message: where.message });
					if (where.kind === 'audio' && !o.transcribes)
						return send(res, 503, { error: 'unavailable', message: 'this converter has no transcription model' });
					const sha256 = url.searchParams.get('sha256'),
						keep = sha256 !== null && /^[0-9a-f]{64}$/.test(sha256) && where.reader === 'pdf';
					const kept = keep ? keptPath(who, sha256) : undefined;
					let path = kept ?? '';
					if (kept === undefined || !existsSync(kept)) {
						path = join(spool, randomUUID());
						const hash = createHash('sha256');
						yield* Effect.tryPromise({
							try: () =>
								pipeline(
									req,
									async function* (source: AsyncIterable<Buffer>) {
										for await (const chunk of source) {
											hash.update(chunk);
											yield chunk;
										}
									},
									createWriteStream(path)
								),
							catch: httpFailed
						});
						if (kept !== undefined) {
							if (hash.digest('hex') !== sha256) {
								rmSync(path, { force: true });
								return send(res, 400, { error: 'The body does not match sha256.' });
							}
							renameSync(path, kept);
							path = kept;
						}
					} else req.resume();
					const job = queue.submit(
						who,
						'ingest',
						JSON.stringify({ op: 'ingest', name, mime, spool: path, options: asked }),
						null,
						url.searchParams.get('lane') ?? '',
						// a page looked at waits behind no bulk read of its tenant's
						asked.page === undefined ? 1 : 0
					);
					pump();
					return send(res, 202, job, { location: `/v1/jobs/${job.id}` });
				}
				if (
					req.method === 'POST' &&
					(url.pathname === '/v1/jobs' || url.pathname === '/v1/convert' || url.pathname === '/v1/ingest')
				) {
					if (stopping) return send(res, 503, { error: 'This replica is shutting down.' });
					if (queue.depth() >= maxQueued || !roomy())
						return send(res, 429, { error: 'The queue is full.' }, { 'retry-after': '30' });
					const raw = yield* body(req, url.pathname === '/v1/convert' ? maxBytes : maxIngestBytes);
					if (url.pathname === '/v1/ingest' || isIngest(raw)) {
						const r = Schema.decodeUnknownResult(IngestBody)(raw);
						if (Result.isFailure(r))
							return send(res, 400, { error: 'The body is { name, mime, bytes (base64) }.' });
						const { bytes: base64, op: _, ...stored } = r.success;
						const where = route(stored.name, stored.mime);
						if (!where.ok) return send(res, 415, { error: 'unsupported', message: where.message });
						const bytes = Buffer.from(base64, 'base64');
						if (where.kind === 'audio' && !o.transcribes)
							return send(res, 503, { error: 'unavailable', message: 'this converter has no transcription model' });
						const path = join(spool, randomUUID());
						yield* Effect.tryPromise({ try: () => writeFile(path, bytes), catch: httpFailed });
						const job = queue.submit(who, 'ingest', JSON.stringify({ op: 'ingest', ...stored, spool: path }), null);
						pump();
						if (url.pathname === '/v1/ingest') return watch(req, res, who, job.id, true);
						return send(res, 202, job, { location: `/v1/jobs/${job.id}` });
					}
					if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return send(res, 400, { error: 'The body is a JSON object.' });
					if (Buffer.byteLength(JSON.stringify(raw)) > maxBytes)
						return send(res, 413, { error: `The request is larger than ${maxBytes} bytes.` });
					const parsed = parse(raw);
					if (typeof parsed === 'string') return send(res, 400, { error: parsed });
					const job = queue.submit(
						who,
						parsed.request.to,
						JSON.stringify(parsed.request),
						parsed.reference
					);
					pump();
					if (url.pathname === '/v1/convert') return watch(req, res, who, job.id, true);
					return send(res, 202, job, { location: `/v1/jobs/${job.id}` });
				}
				const m = /^\/v1\/jobs\/([0-9a-f-]{36})(\/events|\/result)?$/.exec(url.pathname);
				if (req.method !== 'GET' || !m) return send(res, 404, { error: 'No such route.' });
				const id = m[1]!,
					part = m[2];
				if (part === '/events') return watch(req, res, who, id, url.searchParams.has('result'));
				const job = queue.get(who, id);
				if (!job) return send(res, 404, { error: 'No such job.' });
				if (part === undefined) return send(res, 200, job);
				const out = queue.result(who, id);
				if (!out) return send(res, 409, { error: `The job is ${job.state}.`, job });
				const file = join(results, id);
				res.writeHead(200, {
					'content-type': out.mime,
					'content-length': String(statSync(file).size),
					'content-disposition': `attachment; filename="${id}.${out.target === 'ingest' ? 'json' : out.target}"`
				});
				yield* Effect.tryPromise({ try: () => pipeline(createReadStream(file), res), catch: httpFailed });
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (res.headersSent) return void res.end();
						const failure = Cause.squash(cause);
						const error = failure instanceof HttpFailed ? failure : httpFailed(failure);
						send(res, error.status, { error: error.message });
					})
				),
				Effect.asVoid
			)
		);
	});

	return {
		server,
		/** Stops claiming, lets running conversions finish (their lease would requeue them anyway), then closes. */
		stop() {
			// Shutdown must outlive the runtime it disposes rather than belong to its scope.
			return Effect.runPromise(
				Effect.flatMap(runtime.contextEffect, (context) =>
					Effect.gen(function* () {
						stopping = true;
						yield* Fiber.interrupt(claiming);
						const work = yield* Work;
						yield* FiberSet.awaitEmpty(work.conversions);
						yield* Fiber.interrupt(leases);
						yield* Effect.callback<void, CloseFailed>((resume) => {
							server.closeAllConnections();
							server.close((error) =>
								resume(
									error === undefined
										? Effect.void
										: Effect.fail(new CloseFailed({ message: error.message }))
								)
							);
						});
						yield* FiberSet.awaitEmpty(work.requests);
					}).pipe(Effect.provideContext(context))
				).pipe(
					Effect.ensuring(
						Fiber.interruptAll([claiming, leases]).pipe(
							Effect.andThen(Effect.sync(() => queue.close()))
						)
					),
					Effect.ensuring(runtime.disposeEffect),
					Effect.uninterruptible
				)
			);
		}
	};
}

if (import.meta.main) {
	const env = process.env;
	const int = (name: string) => (env[name] ? Number(env[name]) : undefined);
	const timeoutMs = (int('CONVERT_TIMEOUT_S') ?? 60) * 1000;
	const document = pandoc({ timeoutMs, heap: env['CONVERT_PANDOC_HEAP'] ?? '512m' });
	const executable = env['CONVERT_CHROMIUM_EXECUTABLE'];
	const print = executable ? layoutPdf({ executable, timeoutMs }) : null;
	const svc = service({
		keys: (env['CONVERT_API_KEYS'] ?? '')
			.split(',')
			.map((k) => k.trim())
			.filter(Boolean),
		database: join(env['CONVERT_DATA'] ?? '/var/lib/convert', 'jobs.db'),
		convert: (request, reference) => request.from === 'layout-html' && print ? print(request, reference) : document(request, reference),
		ingest: spawned((int('CONVERT_INGEST_TIMEOUT_S') ?? 1800) * 1000),
		transcribes: Boolean(env['CONVERT_AI_API_KEY'] && env['CONVERT_TRANSCRIBE_MODEL']),
		...(int('CONVERT_CONCURRENCY') === undefined
			? {}
			: { concurrency: int('CONVERT_CONCURRENCY')! }),
		...(int('CONVERT_MAX_QUEUED') === undefined ? {} : { maxQueued: int('CONVERT_MAX_QUEUED')! }),
		...(int('CONVERT_MAX_BYTES') === undefined ? {} : { maxBytes: int('CONVERT_MAX_BYTES')! }),
		...(int('CONVERT_INGEST_MAX_BYTES') === undefined
			? {}
			: { maxIngestBytes: int('CONVERT_INGEST_MAX_BYTES')! }),
		...(int('CONVERT_RETAIN_S') === undefined ? {} : { retainMs: int('CONVERT_RETAIN_S')! * 1000 })
	});
	const port = int('PORT') ?? 8080;
	svc.server.listen(port, () => console.log(`convert listening on :${port}`));
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void svc.stop());
}
