// Runtime gaps the template migration found (§5.8, §5.8.1, §3.3.5, rules 55, 56): `ctx.progress` in automations, stopping
// a queued or running run (the engine, the shell route and `$bolt.runs.stop`), the files facility over the host's files
// port (put, get, meta and url, seeded files included), an integration's `resolve` carried by `bolt check`, and a
// recalled channel message removing its mirrored row.
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest, TransportEvent } from '../src/engine/contracts.ts';
import { testWorkspace } from '../src/test/index.ts';
import { loadPackWithAssets } from '../src/compiler/artifact/read.ts';
import { check } from '../src/compiler/check/index.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { loadKeys, mint } from '../src/engine/identity/session.ts';
import { devTurnstile, shellHost } from '../src/shell/host.ts';
import { COOKIES } from '../src/shell/nav.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { guestSource as mailGuest, mail, manifest as mailManifest } from './integrations-fixture.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		notes: { description: 'A note', label: 'title', fields: { title: { kind: 'text' } } },
		docs: { description: 'A document', label: 'title', fields: { title: { kind: 'text' }, file: { kind: 'file', accept: ['text/*'], max: '1MiB', optional: true } } },
		secrets: { description: 'Hidden', label: 'title', fields: { title: { kind: 'text' }, file: { kind: 'file', accept: ['text/*'], max: '1MiB', optional: true } } },
	},
	relationships: {},
	collections: {
		notes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } },
		docs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'file'] } } },
		secrets: { read: { fields: 'all' }, create: { input: { columns: ['title', 'file'] } } },
	},
	integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
	policies: { ops: { description: 'Ops', grants: { notes: { read: true, create: true }, docs: { read: true } }, automations: ['report', 'long', 'bundle', 'read_doc'] } },
	automations: {
		report: { description: 'Reports progress', runAs: ['ops'] },
		long: { description: 'Runs until stopped', runAs: ['ops'], input: { title: { kind: 'text' } } },
		bundle: { description: 'Stores a file and reads it back', runAs: ['ops'] },
		read_doc: { description: 'Reads a stored file', runAs: ['ops'], input: { ref: { kind: 'json' } } },
	},
} as unknown as EngineManifest;

const source = `export default { automation: {
	report: { body: async (_, ctx) => { await ctx.progress({ ratio: 0.5, text: 'half' }); return 'done'; } },
	long: { body: async (input, ctx) => {
		await ctx.progress({ ratio: 0.1, text: 'start' });
		await ctx.http('hq').get('/pause', { output: { kind: 'json' } });
		if (input.title === 'progress') await ctx.progress({ ratio: 0.5, text: 'half' });
		await ctx.act('notes.create', { title: input.title });
		return 'finished';
	} },
	bundle: { body: async (_, ctx) => {
		const ref = await ctx.files.put(new TextEncoder().encode('hello'), { name: 'a.txt', mime: 'text/plain', for: 'bundle' });
		const bytes = await ctx.files.get(ref);
		return { ref, text: new TextDecoder().decode(bytes), meta: await ctx.files.meta(ref), url: await ctx.files.url(ref),
			big: await ctx.files.get.try(ref, { max: 2 }) };
	} },
	read_doc: { body: async ({ ref }, ctx) => ({ text: new TextDecoder().decode(await ctx.files.get(ref)), meta: await ctx.files.meta(ref) }) },
} };`;

const sql = async (t: Awaited<ReturnType<typeof testWorkspace>>, text: string, params: Json[] = []) => (await t.db.read([{ text, params }]))[0]!.rows;
const ops = (t: Awaited<ReturnType<typeof testWorkspace>>) => t.as(t.member(['ops']));

describe('ctx.progress (L-BOLT-336)', () => {
	it('an automation reports progress onto its run', async () => {
		const t = await testWorkspace({ manifest, guest: { source } });
		const started = await ops(t).start('report', {}, { id: randomUUID() });
		expect(started.kind).toBe('committed');
		await t.runDue();
		const [run] = await sql(t, `SELECT id, state, progress, error FROM sys_run WHERE automation = 'report'`);
		expect(run).toMatchObject({ state: 'succeeded', progress: { ratio: 0.5, text: 'half' }, error: null });
		expect(await t.engine.runs!.view(t.as(t.admin).authority, String(run!['id']))).toMatchObject({ progress: { ratio: 0.5, text: 'half' } });
	});
});

describe('stopping a run', () => {
	it('a queued run stops before it starts; only a holder of its automation or an admin may stop it', async () => {
		const t = await testWorkspace({ manifest, guest: { source } });
		const id = randomUUID();
		await ops(t).start('report', {}, { id });
		expect(await t.engine.runs!.stop(t.as(t.member([])).authority, id)).toBeNull();
		expect(await t.engine.runs!.stop(ops(t).authority, id)).toMatchObject({ status: 'stopped' });
		await t.runDue();
		expect(await sql(t, `SELECT state, progress, output FROM sys_run WHERE id = $1`, [id])).toEqual([{ state: 'stopped', progress: null, output: null }]);
	});

	it('a running run stops at its next crossing and stays stopped; a stop recorded elsewhere is seen at its next progress', async () => {
		let stop = async () => {};
		const t = await testWorkspace({ manifest, guest: { source }, runs: { facility: async () => { await stop(); return { ok: true, value: {} }; } } });
		const id = randomUUID();
		stop = async () => { await t.engine.runs!.stop(t.as(t.admin).authority, id); };
		await ops(t).start('long', { title: 'never' }, { id });
		await t.runDue();
		expect(await sql(t, `SELECT state, error->>'code' AS code FROM sys_run WHERE id = $1`, [id])).toEqual([{ state: 'stopped', code: 'stopped' }]);
		expect(await sql(t, `SELECT title FROM notes`)).toEqual([]);

		// another process stopped it: this one sees it when the run next reports progress
		const other = randomUUID();
		stop = async () => { await t.db.write({ text: `UPDATE sys_run SET state = 'stopped' WHERE id = $1`, params: [other] }); };
		await ops(t).start('long', { title: 'progress' }, { id: other });
		await t.runDue();
		expect(await sql(t, `SELECT state FROM sys_run WHERE id = $1`, [other])).toEqual([{ state: 'stopped' }]);
		expect(await sql(t, `SELECT title FROM notes`)).toEqual([]);
	});

	it('the shell route stops a run for its holder, and `$bolt.runs.stop` calls it', async () => {
		const t = await testWorkspace({ manifest, guest: { source } });
		const identity = { db: t.db, now: () => new Date(t.clock.now()), windows: new RateWindows(), keys: await loadKeys(t.db),
			mail: { send: async () => ({ providerId: 'x' }), subscribe: () => () => {} }, devSink: true, publicUrl: 'https://acme.example' };
		const shell = shellHost({ manifest, identity, authorities: new Authorities(manifest, 'test'), ip: () => '203.0.113.9', turnstile: devTurnstile,
			workspace: { name: 'Acme', handle: 'acme' }, secure: false, runs: t.engine.runs! } as never);
		const user = randomUUID();
		await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, 'ops@acme.example', 'Ops', 'staff', false)`, params: [user] });
		await t.db.write({ text: `INSERT INTO sys_assignment (id, principal_type, principal, policy) VALUES ($1, 'sys_user', $2, 'ops')`, params: [randomUUID(), user] });
		const s = await mint(identity, user);
		if (!s.ok) throw new Error(s.message);
		const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const r = new Request(new URL(String(input), 'https://acme.example'), init);
			r.headers.set('cookie', `${COOKIES.session}=${encodeURIComponent(s.value.token)}`);
			return await shell.handle(r) ?? new Response(null, { status: 404 });
		}) as typeof fetch;
		const id = randomUUID();
		await ops(t).start('report', {}, { id });
		const api = shellApi(f);
		expect(await api.stopRun(id)).toMatchObject({ ok: true, value: { id, status: 'stopped' } });
		expect(await api.stopRun(randomUUID())).toMatchObject({ ok: false, status: 404 });
	});
});

describe('the files facility in automations (§5.8.1)', () => {
	it('puts bytes as a FileRef on the run and reads them back, with meta, a URL and the max bound', async () => {
		const t = await testWorkspace({ manifest, guest: { source } });
		await ops(t).start('bundle', {}, { id: randomUUID() });
		await t.runDue();
		const [run] = await sql(t, `SELECT state, output, error FROM sys_run WHERE automation = 'bundle'`);
		expect(run).toMatchObject({ state: 'succeeded', error: null });
		const out = run!['output'] as { ref: { id: string }; text: string; meta: Json; url: string; big: Json };
		expect(out.text).toBe('hello');
		expect(out.ref).toMatchObject({ name: 'a.txt', mime: 'text/plain', bytes: 5, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(out.meta).toEqual(out.ref);
		expect(out.url).toBe(`memory://${(await sql(t, `SELECT key FROM sys_file WHERE id = $1`, [out.ref.id]))[0]!['key']}`);
		expect(out.big).toMatchObject({ kind: 'tooLarge' });
		expect(await sql(t, `SELECT field, size FROM sys_file WHERE id = $1`, [out.ref.id])).toEqual([{ field: 'bundle', size: 5 }]);
	});

	it('reads an uploaded file the runAs may read, and refuses one it may not', async () => {
		const t = await testWorkspace({ manifest, guest: { source } });
		const admin = t.as(t.admin);
		const doc = await admin.upload('docs.file', { name: 'n.txt', mime: 'text/plain', bytes: new TextEncoder().encode('note') });
		const hidden = await admin.upload('secrets.file', { name: 's.txt', mime: 'text/plain', bytes: new TextEncoder().encode('shh') });
		if (doc.kind !== 'committed' || hidden.kind !== 'committed') throw new Error('upload failed');
		await admin.act('docs.create', { title: 'd', file: doc.output });
		await admin.act('secrets.create', { title: 's', file: hidden.output });
		await ops(t).start('read_doc', { ref: doc.output }, { id: randomUUID() });
		await ops(t).start('read_doc', { ref: hidden.output }, { id: randomUUID() });
		await t.runDue();
		const runs = await sql(t, `SELECT input->'ref'->>'name' AS name, state, output, error->>'message' AS message FROM sys_run WHERE automation = 'read_doc' ORDER BY name`);
		expect(runs[0]).toMatchObject({ name: 'n.txt', state: 'succeeded', output: { text: 'note', meta: { bytes: 4 } } });
		expect(runs[1]).toMatchObject({ name: 's.txt', state: 'failed', message: expect.stringContaining('cannot read') });
	});

	it('a seeded file carries its size and digest, and an automation reads its bytes', async () => {
		const t = await testWorkspace({ manifest, guest: { source } });
		const dir = join(scratch, `pack-${randomUUID()}`);
		mkdirSync(join(dir, 'assets', 'docs'), { recursive: true });
		writeFileSync(join(dir, 'assets', 'docs', 'seed.txt'), 'seeded');
		await t.db.write({ text: 'DELETE FROM sys_run', params: [] });
		const loaded = await loadPackWithAssets(t.db, manifest, { dir, rows: { docs: [{ id: randomUUID(), title: 'S', file: { asset: 'docs/seed.txt' } }] },
			meta: { format: 1, name: 'base', hash: 'h', start: [], rows: { docs: 1 }, assets: [{ path: 'docs/seed.txt', bytes: 6, sha256: 'a'.repeat(64), contentType: 'text/plain' }] } },
		t.fakes.files, t.clock.now());
		expect(loaded).toBe(true);
		const [row] = await sql(t, `SELECT file FROM docs`);
		expect(row!['file']).toMatchObject({ name: 'seed.txt', mime: 'text/plain', bytes: 6, sha256: 'a'.repeat(64) });
		await ops(t).start('read_doc', { ref: row!['file']! }, { id: randomUUID() });
		await t.runDue();
		expect((await sql(t, `SELECT state, output FROM sys_run WHERE automation = 'read_doc'`))[0]).toMatchObject({ state: 'succeeded', output: { text: 'seeded', meta: { bytes: 6 } } });
	});
});

describe('channel-sourced integrations', () => {
	it('a recalled mail removes its mirrored row', async () => {
		const t = await testWorkspace({ manifest: mailManifest, guest: { source: mailGuest } });
		let sink: ((e: TransportEvent) => Promise<void>) | undefined;
		t.engine.integrations.subscribe([{ send: async () => ({ providerId: 'p' }), subscribe: (x) => { sink = x; return () => {}; } }], randomUUID);
		const receive = async (message: Json) => { await sink!({ kind: 'inbound', channel: 'supplier_inbox', message }); await t.runDue(); };
		await receive(mail());
		expect(await sql(t, `SELECT message_id FROM pcn_notices`)).toEqual([{ message_id: '<pcn-1@onsemi.com>' }]);
		await receive({ id: '<pcn-1@onsemi.com>', thread: null, deleted: true });
		expect(await sql(t, `SELECT message_id FROM pcn_notices`)).toEqual([]);
	});

	it('`bolt check` keeps a declared resolve, and a delivery runs it', async () => {
		const root = copy('resolve');
		writeFileSync(join(root, 'src/data/model/notices/+model.ts'), `import { model } from '@norbital-ai/bolt';
export default model({ description: 'Mirrored notices', label: 'subject', key: ['message_id'], fields: { message_id: { kind: 'text' }, subject: { kind: 'text' }, sender: { kind: 'text', optional: true } } });`);
		writeFileSync(join(root, 'src/data/collection/notices/+integration.ts'), `import { integration } from '@norbital-ai/bolt';
export default integration('notices', { direction: 'one_way', source: { channel: 'mail', inbound: true }, identity: 'message_id', policies: ['sales_rep'],
	resolve: async () => ({ 'onsemi.com': 'onsemi' }),
	fields: { subject: 'subject', sender: { in: (m, { resolve }) => resolve[m.from.address.split('@')[1]] ?? null } } });`);
		const c = await check(root);
		expect(c.errors).toEqual([]);
		expect(c.manifest!.integrations['notices']).toHaveProperty('resolve');
		const t = await testWorkspace({ root, seed: 'none' });
		await t.fakes.transports.email.emit({ kind: 'inbound', channel: 'mail', message: mail({ from: { address: 'pcn@onsemi.com', name: null } }) });
		await t.runDue();
		expect(await sql(t, `SELECT message_id, sender FROM notices`)).toEqual([{ message_id: '<pcn-1@onsemi.com>', sender: 'onsemi' }]);
	}, 120_000);
});

const FIXTURE = fileURLToPath(new URL('./fixtures/good', import.meta.url));
const scratch = join(tmpdir(), 'norbital-scratch', `runtime-${randomUUID()}`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function copy(name: string): string {
	const root = join(scratch, name);
	cpSync(FIXTURE, root, { recursive: true, filter: (p) => !p.includes('.norbital') });
	for (const f of readdirSync(join(root, 'src'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts'))) {
		const p = join(root, 'src', f);
		writeFileSync(p, readFileSync(p, 'utf8').replace(/'(\.\.\/)+src\/index\.ts'/g, "'@norbital-ai/bolt'"));
	}
	writeFileSync(join(root, 'tsconfig.json'), '{}');
	return root;
}
