// Norbital Convert: Markdown or HTML to pdf, docx, pptx, odt, epub or html over HTTP, behind API keys.
//
//   POST /v1/convert            { from, to, source, page?, landscape?, reference? } → Server-Sent Events: the job on
//                               every change, then `event: result` { mime, to, bytes (base64) } once it succeeds
//   POST /v1/jobs               the same body → 202 job, for callers that watch or fetch later
//   GET  /v1/jobs/:id           the job
//   GET  /v1/jobs/:id/events    the job's events, closed once it settles; `?result` streams the result too (a
//                               /v1/convert whose connection dropped resumes here: the job lives on in the queue)
//   GET  /v1/jobs/:id/result    the converted bytes
//   GET  /healthz               unauthenticated liveness and queue depth
//
// Every replica serves every route and pulls from the shared queue, so any load balancer in front spreads the HTTP and
// the queue spreads the work. A key sees only the jobs it submitted.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { availableParallelism, hostname } from 'node:os';
import { join } from 'node:path';
import { PAPER, STYLED, TARGETS, pandoc, type Converter, type Request, type Target } from './convert.ts';
import { openQueue, type Job } from './queue.ts';

export type Options = {
	keys: readonly string[];
	database: string;
	convert: Converter;
	concurrency?: number;
	maxQueued?: number;
	maxBytes?: number;
	retainMs?: number;
	pollMs?: number;
};

/** A replica renews its leases every LEASE_MS / 3, so a dead one's jobs run elsewhere within LEASE_MS. */
const LEASE_MS = 15_000;
const digest = (s: string) => createHash('sha256').update(s).digest();
const settled = (j: Job) => j.state === 'succeeded' || j.state === 'failed';

export function service(o: Options) {
	const { concurrency = availableParallelism(), maxQueued = 1000, maxBytes = 20 * 1024 * 1024, retainMs = 3_600_000, pollMs = 500 } = o;
	if (o.keys.length === 0) throw new Error('CONVERT_API_KEYS names no key.');
	const keys = o.keys.map(digest);
	const queue = openQueue(o.database);
	const worker = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
	let active = 0, stopping = false;
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
			const request = JSON.parse(claimed.request) as Request;
			o.convert(request, claimed.reference)
				.then((result) => queue.finish(claimed.id, worker, { result, mime: TARGETS[request.to] }),
					(e: unknown) => queue.finish(claimed.id, worker, { error: e instanceof Error ? e.message : String(e) }))
				.finally(() => { active--; changed(); pump(); });
		}
	}
	const timers = [
		setInterval(pump, pollMs),
		setInterval(() => { queue.renew(worker, LEASE_MS); queue.recover(); queue.purge(Date.now() - retainMs); }, LEASE_MS / 3)
	];

	/** The caller's key as its owner id, or undefined; each key is compared in constant time. */
	function owner(req: IncomingMessage) {
		const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
		if (!m) return undefined;
		const d = digest(m[1]!);
		return keys.some((k) => timingSafeEqual(k, d)) ? d.toString('hex').slice(0, 32) : undefined;
	}

	const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
		res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

	async function body(req: IncomingMessage): Promise<unknown> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req as AsyncIterable<Buffer>) {
			size += chunk.length;
			if (size > maxBytes) throw new RangeError(`The request is larger than ${maxBytes} bytes.`);
			chunks.push(chunk);
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	}

	function parse(b: unknown): { request: Request; reference: Uint8Array | null } | string {
		if (typeof b !== 'object' || b === null) return 'The body is a JSON object.';
		const { from, to, source, page, landscape, reference } = b as Record<string, unknown>;
		if (from !== 'markdown' && from !== 'html') return "from is 'markdown' or 'html'.";
		if (typeof to !== 'string' || !(to in TARGETS)) return `to is one of ${Object.keys(TARGETS).join(', ')}.`;
		if (typeof source !== 'string' || source === '') return 'source is the non-empty document text.';
		const target = to as Target;
		if (page !== undefined && (target !== 'pdf' || typeof page !== 'string' || !(page in PAPER))) return `page is a pdf's, one of ${Object.keys(PAPER).join(', ')}.`;
		if (landscape !== undefined && (target !== 'pdf' || typeof landscape !== 'boolean')) return "landscape is a pdf's, true or false.";
		if (reference !== undefined && (!STYLED.includes(target) || typeof reference !== 'string')) return `reference is base64 of a ${STYLED.join(', ')} that styles one.`;
		return {
			request: { from, to: target, source, ...(page === undefined ? {} : { page: page as keyof typeof PAPER }), ...(landscape === undefined ? {} : { landscape }) },
			reference: typeof reference === 'string' ? Buffer.from(reference, 'base64') : null
		};
	}

	function watch(req: IncomingMessage, res: ServerResponse, who: string, id: string, withResult: boolean) {
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
		let last = '';
		const close = () => { watchers.delete(check); clearInterval(tick); clearInterval(ping); res.end(); };
		const check = () => {
			const job = queue.get(who, id);
			if (!job) return close();
			const text = JSON.stringify(job);
			if (text !== last) res.write(`event: job\ndata: ${(last = text)}\n\n`);
			if (!settled(job)) return;
			const out = withResult ? queue.result(who, id) : undefined;
			if (out) res.write(`event: result\ndata: ${JSON.stringify({ mime: out.mime, to: out.target, bytes: Buffer.from(out.result).toString('base64') })}\n\n`);
			close();
		};
		watchers.add(check);
		const tick = setInterval(check, 250), ping = setInterval(() => res.write(': ping\n\n'), 15_000);
		res.on('close', close);
		check();
	}

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', 'http://convert');
			if (req.method === 'GET' && url.pathname === '/healthz') return send(res, stopping ? 503 : 200, { ok: !stopping, queued: queue.depth(), running: active });
			const who = owner(req);
			if (!who) return send(res, 401, { error: 'An API key is required: Authorization: Bearer <key>.' }, { 'www-authenticate': 'Bearer' });
			if (req.method === 'POST' && (url.pathname === '/v1/jobs' || url.pathname === '/v1/convert')) {
				if (stopping) return send(res, 503, { error: 'This replica is shutting down.' });
				if (queue.depth() >= maxQueued) return send(res, 429, { error: 'The queue is full.' }, { 'retry-after': '5' });
				const parsed = parse(await body(req));
				if (typeof parsed === 'string') return send(res, 400, { error: parsed });
				const job = queue.submit(who, parsed.request.to, JSON.stringify(parsed.request), parsed.reference);
				pump();
				if (url.pathname === '/v1/convert') return watch(req, res, who, job.id, true);
				return send(res, 202, job, { location: `/v1/jobs/${job.id}` });
			}
			const m = /^\/v1\/jobs\/([0-9a-f-]{36})(\/events|\/result)?$/.exec(url.pathname);
			if (req.method !== 'GET' || !m) return send(res, 404, { error: 'No such route.' });
			const id = m[1]!, part = m[2];
			if (part === '/events') return watch(req, res, who, id, url.searchParams.has('result'));
			const job = queue.get(who, id);
			if (!job) return send(res, 404, { error: 'No such job.' });
			if (part === undefined) return send(res, 200, job);
			const out = queue.result(who, id);
			if (!out) return send(res, 409, { error: `The job is ${job.state}.`, job });
			res.writeHead(200, { 'content-type': out.mime, 'content-length': String(out.result.byteLength), 'content-disposition': `attachment; filename="${id}.${out.target}"` }).end(out.result);
		} catch (e) {
			if (res.headersSent) return res.end();
			send(res, e instanceof RangeError ? 413 : e instanceof SyntaxError ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
		}
	});

	return {
		server,
		/** Stops claiming, lets running conversions finish (their lease would requeue them anyway), then closes. */
		async stop() {
			stopping = true;
			timers.forEach(clearInterval);
			while (active > 0) await new Promise((r) => setTimeout(r, 100));
			server.closeAllConnections();
			await new Promise((r) => server.close(r));
			queue.close();
		}
	};
}

if (import.meta.main) {
	const env = process.env;
	const int = (name: string) => (env[name] ? Number(env[name]) : undefined);
	const timeoutMs = (int('CONVERT_TIMEOUT_S') ?? 60) * 1000;
	const svc = service({
		keys: (env['CONVERT_API_KEYS'] ?? '').split(',').map((k) => k.trim()).filter(Boolean),
		database: join(env['CONVERT_DATA'] ?? '/var/lib/convert', 'jobs.db'),
		convert: pandoc({ timeoutMs, heap: env['CONVERT_PANDOC_HEAP'] ?? '512m' }),
		...(int('CONVERT_CONCURRENCY') === undefined ? {} : { concurrency: int('CONVERT_CONCURRENCY')! }),
		...(int('CONVERT_MAX_QUEUED') === undefined ? {} : { maxQueued: int('CONVERT_MAX_QUEUED')! }),
		...(int('CONVERT_MAX_BYTES') === undefined ? {} : { maxBytes: int('CONVERT_MAX_BYTES')! }),
		...(int('CONVERT_RETAIN_S') === undefined ? {} : { retainMs: int('CONVERT_RETAIN_S')! * 1000 })
	});
	const port = int('PORT') ?? 8080;
	svc.server.listen(port, () => console.log(`convert listening on :${port}`));
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void svc.stop().then(() => process.exit(0)));
}
