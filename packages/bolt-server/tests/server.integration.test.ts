// Standalone `bolt start` on the next engine (§5.11.6, rules 66, 69, 71, G7): a fixture artifact on PGlite, the founder
// signs in with an emailed code, acts and reads over HTTP, holds a live SSE view, uploads and downloads a file, runs a
// signed host operation, and watches a delayed automation fire from the in-process timekeeper; then SIGTERM-style close.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT } from '../../bolt/src/compiler/artifact/index.ts';
import { artifactHash, sha, treeHash } from '../../bolt/src/compiler/artifact/read.ts';
import type { EngineManifest } from '../../bolt/src/engine/contracts.ts';
import { fingerprint, schemaSlice } from '../../bolt/src/engine/schema/plan.ts';
import { decodeConfig } from '../src/config.ts';
import { devSink } from '../src/mail.ts';
import { ActivationError, start, type Server } from '../src/server.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { quotes: { description: 'A quote', label: 'title', fields: {
		title: { kind: 'text' }, status: { kind: 'enum', values: ['draft', 'sent'], default: 'draft' },
		attachment: { kind: 'file', accept: ['text/plain'], max: '1MiB', optional: true } } } },
	relationships: {},
	collections: { quotes: { read: { fields: 'all' }, create: { input: { columns: ['title', 'attachment'] } }, update: { input: { columns: ['status', 'attachment'] } } } },
	policies: { ops: { description: 'Ops', grants: { quotes: { read: true, create: true, update: true } } } },
	automations: { remind: { description: 'Marks a quote sent a second after creation', on: { created: 'quotes', delay: '1s' }, runAs: ['ops'] } },
	integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;
const guest = `export default { automation: { remind: { body: async (input, ctx) => {
	for (const id of input.ids) await ctx.act('quotes.update', { target: id, set: { status: 'sent' } });
} } } };`;

const root = join(tmpdir(), 'norbital-scratch', `bolt-server-${randomUUID()}`);
const artifact = join(root, 'artifact');
const OPS_KEY = createHash('sha256').update('ops').digest('hex');
const FOUNDER = 'boss@acme.example';

function writeFixture(dir = artifact, m: EngineManifest = manifest): void {
	mkdirSync(join(dir, 'client'), { recursive: true });
	mkdirSync(join(dir, 'assets'), { recursive: true });
	const text = JSON.stringify(m);
	writeFileSync(join(dir, 'manifest.json'), text);
	writeFileSync(join(dir, 'guest.mjs'), guest);
	writeFileSync(join(dir, 'client', 'index.html'), '<!doctype html><div id="bolt"></div>');
	writeFileSync(join(dir, 'assets', 'thumbnail.svg'), '<svg/>');
	// the recorded digests the reader verifies (L-BOLT-903)
	const body = { format: 1, contract: CONTRACT, handle: 'acme', name: 'Acme', schema: fingerprint(schemaSlice(m)),
		transforms: [], client: { entry: '', css: [] }, hashes: { manifest: sha(text), guest: sha(guest), client: treeHash(join(dir, 'client')) } };
	writeFileSync(join(dir, 'artifact.json'), JSON.stringify({ ...body, hash: artifactHash(dir, body as Parameters<typeof artifactHash>[1]) }));
}
const env = (over: { [k: string]: string } = {}) => ({ BOLT_ARTIFACT: artifact, BOLT_PORT: '0', BOLT_PUBLIC_URL: 'http://localhost:3100',
	BOLT_PGLITE_DIR: join(root, 'db'), BOLT_FILES_PROVIDER: 'local', BOLT_FILES_ENDPOINT: join(root, 'files'), BOLT_OPS_KEY: OPS_KEY, ...over });

let server: Server;
const mail = devSink();
let cookie = '';
const call = async (method: string, path: string, body?: unknown, headers: { [k: string]: string } = {}) =>
	fetch(`${server.url}${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
		...(body === undefined ? {} : { body: typeof body === 'string' ? body : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body) }) });
const act = (callable: string, input: unknown) => call('POST', '/__bolt/act', { callable, input, issuedAt: new Date().toISOString() }, { 'Idempotency-Key': randomUUID() });

/** An SSE reader: `next(pred)` resolves with the first frame matching, or rejects after `ms`. */
function frames(res: Response) {
	const reader = res.body!.getReader(), decoder = new TextDecoder(), seen: { [k: string]: unknown }[] = [];
	let buffer = '';
	return {
		async next(pred: (f: { [k: string]: unknown }) => boolean, ms = 5_000): Promise<{ [k: string]: unknown }> {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = seen.findIndex(pred);
				if (hit >= 0) return seen.splice(0, hit + 1).at(-1)!;
				if (Date.now() > deadline) throw new Error(`no matching frame within ${ms} ms`);
				const { value, done } = await Promise.race([reader.read(), new Promise<never>((_, no) => setTimeout(() => no(new Error('stream stalled')), deadline - Date.now()))]);
				if (done) throw new Error('stream ended');
				buffer += decoder.decode(value, { stream: true });
				for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
					const chunk = buffer.slice(0, i); buffer = buffer.slice(i + 2);
					if (chunk.startsWith('data: ')) seen.push(JSON.parse(chunk.slice(6)) as { [k: string]: unknown });
				}
			}
		},
		cancel: () => reader.cancel(),
	};
}

beforeAll(async () => {
	writeFixture();
	server = await start(decodeConfig(env(), [`--founder=${FOUNDER}`]), { mail, log: () => {} });
}, 60_000);
afterAll(async () => {
	await server?.close();
	rmSync(root, { recursive: true, force: true });
});

describe('bolt start on PGlite', () => {
	it('signs the founder in with the emailed code', async () => {
		expect((await call('POST', '/__bolt/session/code', { address: FOUNDER })).status).toBe(200);
		const code = /\b(\d{6})\b/.exec(mail.mail.at(-1)?.text ?? '')?.[1];
		expect(mail.mail.at(-1)?.to).toEqual([FOUNDER]);
		expect(code).toMatch(/^\d{6}$/);
		const r = await call('POST', '/__bolt/session/verify', { address: FOUNDER, code });
		expect(r.status).toBe(200);
		cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
		expect(cookie).toContain('nb_s=');
		expect(r.headers.getSetCookie()[0]).not.toContain('Secure'); // loopback http origin
	});

	it('refuses the protocol without a session', async () => {
		const r = await fetch(`${server.url}/__bolt/q`, { method: 'POST', body: JSON.stringify({ reads: [] }) });
		expect(r.status).toBe(401);
	});

	it('acts and reads over HTTP, holds a live view, and fires the delayed automation', async () => {
		const live = await call('GET', '/__bolt/live');
		expect(live.headers.get('content-type')).toBe('text/event-stream');
		const stream = frames(live);
		const hello = await stream.next((f) => f['t'] === 'hello');
		const reg = await call('POST', '/__bolt/live', { conn: hello['conn'], add: [{ view: 'all', read: { m: 'read', a: ['quotes', { all: true }] } }] });
		expect(await reg.json()).toEqual({ errors: [] });
		await stream.next((f) => f['t'] === 'answer' && f['view'] === 'all');

		const r = await act('quotes.create', { title: 'Q-1' });
		const reply = await r.json() as { outcome: { kind: string; records: { id: string }[] }; v: number };
		expect(r.status).toBe(200);
		expect(reply.outcome.kind).toBe('committed');
		const id = reply.outcome.records[0]!.id;

		const q = await call('POST', '/__bolt/q', { reads: [{ m: 'get', a: ['quotes', id] }] });
		expect(((await q.json()) as { answers: { title: string; status: string }[] }).answers[0]).toMatchObject({ title: 'Q-1', status: 'draft' });

		// a commit reaches the view as a patch of the row (rule 65); a fallback re-read as an answer
		const has = (status: string) => (f: { [k: string]: unknown }) => (f['t'] === 'answer' ? (f['value'] as { rows?: { id: string; status: string }[] }).rows ?? []
			: f['t'] === 'patch' ? (f['ops'] as { op: string; row?: { id: string; status: string } }[]).flatMap((o) => o.op === 'upsert' ? [o.row!] : []) : [])
			.some((x) => x.id === id && x.status === status);
		await stream.next(has('draft'));
		// `{ created, delay: '1s' }`: the create statement queued the run and announced it; the timekeeper wakes once
		await stream.next(has('sent'), 8_000);
		// the run's own commit is live before its row settles; give the settle a bounded moment
		let runs: readonly unknown[] = [];
		for (let i = 0; i < 50; i++) {
			runs = (await server.db.read([{ text: `SELECT automation, state FROM sys_run WHERE automation = 'remind'`, params: [] }]))[0]!.rows;
			if (JSON.stringify(runs).includes('succeeded')) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(runs).toEqual([{ automation: 'remind', state: 'succeeded' }]);
		await stream.cancel();
	}, 20_000);

	it('uploads to a file field and downloads it by id', async () => {
		const bytes = new TextEncoder().encode('hello bolt');
		const up = await call('PUT', '/__bolt/files/quotes.attachment', bytes, { 'content-type': 'text/plain', 'Idempotency-Key': randomUUID(),
			'content-disposition': `attachment; filename*=UTF-8''note.txt` });
		const ref = await up.json() as { id: string; name: string };
		expect(up.status).toBe(200);
		expect(ref.name).toBe('note.txt');
		expect(((await (await act('quotes.create', { title: 'Q-2', attachment: ref })).json()) as { outcome: { kind: string } }).outcome.kind).toBe('committed');
		const down = await call('GET', `/__bolt/files/${ref.id}`);
		expect(down.status).toBe(200);
		expect(await down.text()).toBe('hello bolt');
		expect((await fetch(`${server.url}/__bolt/files/${ref.id}`)).status).toBe(401);
		const refused = await call('PUT', '/__bolt/files/quotes.attachment', bytes, { 'content-type': 'image/png', 'Idempotency-Key': randomUUID() });
		expect(refused.status).toBe(400);
	});

	it('runs a signed host operation once and refuses its replay and a forged MAC', async () => {
		const [u] = await server.db.read([{ text: `SELECT id FROM sys_user WHERE email = $1`, params: [FOUNDER] }]);
		const body = JSON.stringify({ op: 'session.mint', input: { user: u!.rows[0]!['id'] }, runId: randomUUID() });
		const ts = String(Date.now()), nonce = randomUUID();
		const mac = createHmac('sha256', Buffer.from(OPS_KEY, 'hex')).update(['v1', 'acme', 'localhost:3100', 'session.mint', ts, nonce,
			createHash('sha256').update(body).digest('hex')].join('\n')).digest('base64url');
		const send = (m: string) => fetch(`${server.url}/__bolt/ops`, { method: 'POST', body, headers: { 'bolt-op-ts': ts, 'bolt-op-nonce': nonce, 'bolt-op-mac': m } });
		const ok = await send(mac);
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { value: { token: string } }).value.token).toBeTypeOf('string');
		expect((await send(mac)).status).toBe(409);
		expect((await send(mac.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')))).status).toBe(403);
	});

	it('answers a signed host.ping (L-BOLT-298)', async () => {
		const body = JSON.stringify({ op: 'host.ping' }), ts = String(Date.now()), nonce = randomUUID();
		const mac = createHmac('sha256', Buffer.from(OPS_KEY, 'hex')).update(['v1', 'acme', 'localhost:3100', 'host.ping', ts, nonce,
			createHash('sha256').update(body).digest('hex')].join('\n')).digest('base64url');
		const r = await fetch(`${server.url}/__bolt/ops`, { method: 'POST', body, headers: { 'bolt-op-ts': ts, 'bolt-op-nonce': nonce, 'bolt-op-mac': mac } });
		expect(r.status).toBe(200);
		expect(((await r.json()) as { value: { workspace: string } }).value.workspace).toBe('acme');
	});

	it('serves the artifact client for app paths, not for unknown protocol paths', async () => {
		const page = await call('GET', '/app/sales/list');
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('id="bolt"');
		expect((await call('GET', '/__bolt/nothing')).status).toBe(404);
		expect((await call('GET', '/manifest.webmanifest')).headers.get('content-type')).toBe('application/manifest+json');
		const asset = await call('GET', '/assets/thumbnail.svg'); // the artifact's workspace assets
		expect([asset.headers.get('content-type'), await asset.text()]).toEqual(['image/svg+xml', '<svg/>']);
	});

	it('drains on close: open live streams end at once, the port stops listening', async () => {
		const live = frames(await call('GET', '/__bolt/live'));
		await live.next((f) => f['t'] === 'hello');
		const t0 = Date.now();
		await server.close();
		expect(Date.now() - t0).toBeLessThan(3_000);
		await expect(live.next(() => false, 1_000)).rejects.toThrow(/stream ended|terminated|stalled/);
		await expect(fetch(`${server.url}/`)).rejects.toThrow();
	});

	it('activates with every optional provider unbound, warning instead (P19, rule 69)', () => {
		expect(server.warnings.join('\n')).toMatch(/geocoding is not configured/);
	});

	it('--seed loads a pack with its assets into an empty database once, and does nothing over rows (rule 70)', async () => {
		const pack = join(root, 'pack');
		mkdirSync(join(pack, 'rows'), { recursive: true });
		mkdirSync(join(pack, 'assets', 'docs'), { recursive: true });
		const bytes = Buffer.from('seeded note');
		writeFileSync(join(pack, 'assets', 'docs', 'note.txt'), bytes);
		writeFileSync(join(pack, 'pack.json'), JSON.stringify({ format: 1, name: 'base', hash: 'h', start: [], rows: { quotes: 1 },
			assets: [{ path: 'docs/note.txt', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, contentType: 'text/plain' }] }));
		writeFileSync(join(pack, 'rows', 'quotes.jsonl'), `${JSON.stringify({ id: randomUUID(), title: 'seeded', status: 'draft', attachment: { asset: 'docs/note.txt' } })}\n`);
		const lines: string[] = [];
		const cfg = decodeConfig(env({ BOLT_PGLITE_DIR: join(root, 'seeded') }), [`--seed=${pack}`]);
		const count = async (s: Server) => (await s.db.read([{ text: `SELECT count(*)::int AS n FROM quotes`, params: [] }]))[0]!.rows[0]!['n'];
		let s = await start(cfg, { mail, log: (l) => lines.push(l) });
		expect(await count(s)).toBe(1);
		// the asset became a sys_file row in the files store, and the row holds its FileRef
		const [row] = await s.db.read([{ text: `SELECT q.attachment, f.key, f.field, f.size FROM quotes q JOIN sys_file f ON f.id = q.attachment->>'id'`, params: [] }]);
		const hit = row!.rows[0]!;
		expect(hit).toMatchObject({ attachment: { name: 'note.txt', mime: 'text/plain' }, field: 'quotes.attachment', size: bytes.length });
		expect(readFileSync(join(root, 'files', String(hit['key'])), 'utf8')).toBe('seeded note');
		await s.close();
		s = await start(cfg, { mail, log: (l) => lines.push(l) });
		expect(await count(s)).toBe(1);
		await s.close();
		expect(lines.filter((l) => l.startsWith('--seed'))).toEqual([expect.stringMatching(/loaded pack base/), expect.stringMatching(/nothing seeded/)]);
	}, 60_000);

	it('refuses activation without the required facilities and on a foreign contract', async () => {
		await expect(start(decodeConfig(env({ BOLT_PGLITE_DIR: join(root, 'db2') }), []), { log: () => {} })).rejects.toThrow(/BOLT_MAIL/);
		const { BOLT_FILES_PROVIDER: _p, BOLT_FILES_ENDPOINT: _e, ...noFiles } = env({ BOLT_PGLITE_DIR: join(root, 'db3') });
		await expect(start(decodeConfig(noFiles, []), { mail, log: () => {} })).rejects.toThrow(/files are required/);
		await expect(start(decodeConfig(env({ BOLT_PGLITE_DIR: join(root, 'db4') }), []), { mail, contracts: ['other'], log: () => {} })).rejects.toBeInstanceOf(ActivationError);
		const tampered = join(root, 'tampered');
		writeFixture(tampered);
		writeFileSync(join(tampered, 'manifest.json'), JSON.stringify({ ...manifest, models: {} }));
		await expect(start(decodeConfig(env({ BOLT_ARTIFACT: tampered, BOLT_PGLITE_DIR: join(root, 'db5') }), []), { mail, log: () => {} })).rejects.toThrow(/schema hash/);
	});

	it('refuses a destructive schema step without --accept and applies it with (rule 69)', async () => {
		const narrower = join(root, 'narrower');
		const quotes = (manifest.models as { [k: string]: { fields: { [f: string]: unknown } } })['quotes']!;
		const { attachment: _dropped, ...fields } = quotes.fields;
		writeFixture(narrower, { ...manifest, models: { quotes: { ...quotes, fields } },
			collections: { quotes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } }, update: { input: { columns: ['status'] } } } } } as unknown as EngineManifest);
		const db = { BOLT_PGLITE_DIR: join(root, 'db6') };
		await (await start(decodeConfig(env(db), []), { mail, log: () => {} })).close();
		await expect(start(decodeConfig(env({ ...db, BOLT_ARTIFACT: narrower }), []), { mail, log: () => {} })).rejects.toThrow(/--accept/);
		await (await start(decodeConfig(env({ ...db, BOLT_ARTIFACT: narrower }), ['--accept']), { mail, log: () => {} })).close();
	}, 60_000);

	const pgUrl = process.env['BOLT_TEST_POSTGRES_URL'];
	it.skipIf(pgUrl === undefined)('serves on Postgres: TLS by default, plain only with sslmode=disable (§5.11.6)', async () => {
		const { default: pg } = await import('pg');
		const name = `bolt_start_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
		const admin = new pg.Client({ connectionString: pgUrl });
		await admin.connect();
		await admin.query(`CREATE DATABASE ${name}`);
		try {
			const at = (q: string) => { const u = new URL(pgUrl!); u.pathname = `/${name}`; u.search = q; return u.href; };
			const pgEnv = (url: string) => { const { BOLT_PGLITE_DIR: _d, ...rest } = env(); return { ...rest, BOLT_DATABASE_URL: url }; };
			await expect(start(decodeConfig(pgEnv(at('')), []), { mail, log: () => {} })).rejects.toThrow(/SSL|TLS/i); // the local server offers no TLS
			const s = await start(decodeConfig(pgEnv(at('?sslmode=disable')), []), { mail, log: () => {} });
			const [r] = await s.db.read([{ text: `SELECT count(*)::int AS n FROM quotes`, params: [] }]);
			expect(r!.rows[0]!['n']).toBe(0);
			await s.close();
		} finally {
			await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			await admin.end();
		}
	}, 60_000);
});
