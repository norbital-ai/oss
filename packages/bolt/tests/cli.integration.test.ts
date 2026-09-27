/// <reference types="node" />
// The bolt CLI (§3.7, §5.1, rules 7, 69, 70) on a copy of the P1 good fixture: `bolt build` writes a deterministic
// artifact and its seed packs (base from `seed/**`, sample from a bank tree through the default reader or `seed/seed.ts`,
// with rule 70's `start`), and `bolt dev`'s host serves it on PGlite: sign-in with the dev sink, seeded reads, the
// first-admission run, the client document, and a hot swap that keeps the database.
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readArtifact, readPack } from '../src/compiler/artifact/index.ts';
import { workspaceFiles } from '../src/compiler/artifact/read.ts';
import { AuthorErrors, buildWorkspace } from '../src/cli/build.ts';
import { devHost, localFiles, type DevHost } from '../src/cli/dev.ts';
import { main } from '../src/cli/main.ts';
import { openPglite } from '../src/engine/db/pglite.ts';

const BOLT = fileURLToPath(new URL('../src/index.ts', import.meta.url));
// the client as templates see it: its built declarations (the source's ui augmentation needs ui as an installed package)
const CLIENT = fileURLToPath(new URL('../build/client/index.d.ts', import.meta.url));
const UI = fileURLToPath(new URL('../../ui/build/index.d.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/good', import.meta.url));
const scratch = join(tmpdir(), 'norbital-scratch', `cli-${randomUUID()}`);
const root = join(scratch, 'good'), bank = join(scratch, 'bank');
const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

/** The good fixture as a workspace of its own: bolt by package name and a tsconfig for its new location. */
function workspace(): void {
	cpSync(FIXTURE, root, { recursive: true, filter: (p) => !p.includes('.norbital') });
	for (const f of readdirSync(join(root, 'src'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts'))) {
		const p = join(root, 'src', f);
		writeFileSync(p, readFileSync(p, 'utf8').replace(/'(\.\.\/)+src\/index\.ts'/g, "'@norbital-ai/bolt'"));
	}
	// the generated type setup (`.norbital/tsconfig.json`, `bolt.d.ts`), with bolt resolved to this checkout's source
	write(join(root, 'tsconfig.json'), JSON.stringify({ extends: './.norbital/tsconfig.json', compilerOptions: { rootDir: '/',
		paths: { '@norbital-ai/bolt': [BOLT], '@norbital-ai/bolt/client': [CLIENT], '@norbital-ai/ui': [UI] } } }));
	// a file field, a bank asset for it, and a workspace asset shipped in the artifact
	const model = join(root, 'src/data/model/customers/+model.ts');
	writeFileSync(model, readFileSync(model, 'utf8').replace("name: { kind: 'text' },", "name: { kind: 'text' }, logo: { kind: 'file', accept: ['image/*'], max: '1MiB', optional: true },"));
	write(join(root, 'assets/thumbnail.svg'), '<svg/>');
	// a page reading `$bolt`, typed by the generated `.norbital/bolt.d.ts` (the build resolves it to the booted shell client)
	write(join(root, 'src/app/sales/+list.page.svelte'), `<script lang="ts">import { bolt } from '$bolt';</script>\n<p>{bolt.locale}</p>\n`);
	// a page with a ui view: it must share the shell's ui (one `$bolt` context), never bundle a copy of its own
	write(join(root, 'src/app/sales/+board.page.svelte'), `<script lang="ts">import { Table } from '@norbital-ai/ui';</script>\n<Table of="customers" columns={['name']} />\n`);
	write(join(root, 'norbital.template.json'), JSON.stringify({ key: 'norbital_good', name: { en: 'Good' }, bank: 'acme' }));
	write(join(bank, 'acme/team.json'), JSON.stringify([{ id: 't2', name: 'Inside', parent_id: 't1' }, { id: 't1', name: 'Sales' }]));
	write(join(bank, 'acme/user.json'), JSON.stringify([{ id: 'u1', name: 'Ann', email: 'ann@acme.example', status: 'admin', team_id: 't2' },
		{ id: 'u2', name: 'Bob', email: 'bob@acme.example', status: 'normal', team_id: 't1' }]));
	write(join(bank, 'acme/customers.json'), JSON.stringify([{ id: '0199a000-0000-4000-8000-0000000000b1', name: 'Bank Co', logo: { asset: 'logos/bank.png' } }]));
	write(join(bank, 'acme/logos/bank.png'), 'PNG bytes');
}

beforeAll(workspace);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('bolt build', () => {
	it('writes the artifact (check + tsc + svelte-check green) and rebuilds it byte for byte', async () => {
		const { artifact, packs } = await buildWorkspace(root, { bank });
		const out = join(root, '.norbital/artifact');
		for (const f of ['artifact.json', 'manifest.json', 'schema.sql', 'guest.mjs', 'client/index.html', 'skills/triage.md']) expect(existsSync(join(out, f)), f).toBe(true);
		expect(artifact.artifact).toMatchObject({ format: 1, handle: 'norbital_good', name: 'Good' });
		expect(readFileSync(join(out, 'client/index.html'), 'utf8')).toContain(`/${artifact.artifact.client.entry}`);
		const pages = readdirSync(join(out, 'client/assets')).filter((f) => f.includes('.page-') && f.endsWith('.js'));
		expect(pages).toHaveLength(3);
		for (const p of pages) expect(readFileSync(join(out, 'client/assets', p), 'utf8'), p).not.toContain('A view needs the shell');
		// the bundle carries the messages (base and locales), the record view and ui's stylesheet
		const shell = readFileSync(join(out, 'client', artifact.artifact.client.entry), 'utf8');
		for (const text of ['Hello', 'Helo', 'record.tab.record']) expect(shell, text).toContain(text);
		// the account menu's versions are baked, never left as the free global (L-BOLT-073)
		const bundle = readdirSync(join(out, 'client/assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'client/assets', f), 'utf8')).join('\n');
		expect(bundle).not.toContain('__BOLT_BUILD__');
		expect(bundle).toContain(process.versions.node);
		expect(artifact.artifact.client.css.length).toBeGreaterThan(0);
		expect(readFileSync(join(out, 'schema.sql'), 'utf8')).toMatch(/create table "?customers"?/i);
		expect(Object.keys(packs)).toEqual(['base', 'sample']);
		expect(packs['base']!.rows).toEqual({ customers: 1 });
		expect(packs['sample']!.rows).toEqual({ customers: 1, sys_team: 2, sys_user: 2 });
		expect(packs['sample']!.assets).toEqual([{ path: 'logos/bank.png', bytes: 9, sha256: expect.any(String), contentType: 'image/png' }]);
		expect(readPack(join(root, '.norbital/seed/sample')).rows['sys_user']).toEqual([
			{ id: 'u1', name: 'Ann', email: 'ann@acme.example', kind: 'staff', admin: true, team: 't2' },
			{ id: 'u2', name: 'Bob', email: 'bob@acme.example', kind: 'staff', admin: false, team: 't1' }]);
		// the agent's workspace: the source as released and the checker's type index (`workspace_read`, `workspace_type`)
		const ws = workspaceFiles(out)!;
		expect(await ws.files()).toContain('src/data/collection/orders/+collection.ts');
		expect(await ws.read('src/agent/skill/+triage.skill.md')).toContain('description: Triage a notice');
		expect(await ws.read('../manifest.json')).toBeNull();
		const types = (await ws.types())!;
		expect(types['collections.orders.queries.count_placed']).toMatchObject({ type: '{\n\tinput: {};\n\toutput: number;\n}', docs: 'Placed orders',
			source: 'src/data/collection/orders/+collection.ts:6' });
		expect(types['collections.customers.create']!.type).toMatch(/readonly name: string; readonly rating\?: number \| null;/);
		expect(types['customFields.rating']).toMatchObject({ type: 'number', docs: 'A score' });
		expect(types['components.data/custom_field/rating/+renderer']).toMatchObject({ type: '{\n\tview: unknown;\n}', source: 'src/data/custom_field/rating/+renderer.svelte' });
		const files = () => Object.fromEntries(readdirSync(join(out, 'client'), { recursive: true }).map(String).sort()
			.filter((f) => !f.endsWith('/') && existsSync(join(out, 'client', f)) && !statSync(join(out, 'client', f)).isDirectory())
			.map((f) => [f, createHash('sha256').update(readFileSync(join(out, 'client', f))).digest('hex')]));
		const before = files();
		const again = await buildWorkspace(root, { bank, types: false });
		// file by file first, so a difference names the file that moved
		expect(files()).toEqual(before);
		expect(again.artifact.artifact.hashes).toEqual(artifact.artifact.hashes);
		expect(again.artifact.artifact.snapshot).toEqual(artifact.artifact.snapshot);
		expect(again.artifact.artifact.hash).toBe(artifact.artifact.hash);
		expect(again.packs['sample']!.hash).toBe(packs['sample']!.hash);
		// L-BOLT-903: activation verifies every recorded digest
		expect(() => readArtifact(out)).not.toThrow();
		for (const f of ['guest.mjs', 'manifest.json', 'client/index.html', 'skills/triage.md']) {
			const was = readFileSync(join(out, f), 'utf8');
			writeFileSync(join(out, f), f === 'manifest.json' ? `${was} ` : `${was}\n//`);
			expect(() => readArtifact(out), f).toThrow(/does not match its recorded digest/);
			writeFileSync(join(out, f), was);
		}
		// the guest snapshot is this host's, and verified like the rest
		expect(artifact.guest.snapshot).toBeInstanceOf(Uint8Array);
		const snapshot = readFileSync(join(out, 'guest.snapshot'));
		writeFileSync(join(out, 'guest.snapshot'), Buffer.concat([snapshot, Buffer.from([0])]));
		expect(() => readArtifact(out)).toThrow(/snapshot does not match its recorded digest/);
		writeFileSync(join(out, 'guest.snapshot'), snapshot);
	}, 90_000);

	it('reads the bank through seed/seed.ts, and a start entry that is no automation is a build error', async () => {
		write(join(root, 'seed/seed.ts'), `import type { SeedSource } from '@norbital-ai/bolt';
import { cents } from '../src/lib/money.ts';
export default { bank: 'acme', start: ['nightly'],
	rows: (bank) => ({ customers: bank.has('customers.json') ? bank.json<{ id: string; name: string }[]>('customers.json').map((c) => ({ ...c, name: c.name + ' ' + cents(1) })) : [] }),
} satisfies SeedSource;`);
		const { packs } = await buildWorkspace(root, { bank, types: false });
		expect(packs['sample']).toMatchObject({ start: ['nightly'], rows: { customers: 1 } });
		expect(readPack(join(root, '.norbital/seed/sample')).rows['customers']![0]).toMatchObject({ name: 'Bank Co 100' });
		write(join(root, 'seed/seed.ts'), `export default { bank: 'acme', start: ['nope'], rows: () => ({}) };`);
		const failed = await buildWorkspace(root, { bank, types: false }).catch((e: unknown) => e);
		expect(failed).toBeInstanceOf(AuthorErrors);
		expect((failed as AuthorErrors).errors.map((e) => e.code)).toEqual(['seed/start']);
		write(join(root, 'seed/seed.ts'), `export default { bank: 'acme', start: ['nightly'], rows: (b) => !b.has('team.json') ? {} : ({ sys_team: b.json('team.json').map((t) => ({ id: t.id, name: t.name, parent: t.parent_id ?? null })), customers: b.json('customers.json') }) };`);
	}, 60_000);

	it('exits 1 on an author error and prints every diagnostic', async () => {
		const bad = join(scratch, 'bad');
		write(join(bad, 'src/+workspace.ts'), `export default { tz: 'UTC', locale: 'en' };`);
		write(join(bad, 'src/automations/+x.automation.ts'), 'export default {};');
		expect(await main(['check', bad])).toBe(1);
		expect(await main(['nonsense'])).toBe(2);
	}, 30_000);
});

describe('bolt dev host', () => {
	let host: DevHost;
	const port = 5300 + Math.floor(Math.random() * 500);
	beforeAll(async () => {
		const { artifact } = await buildWorkspace(root, { bank, types: false });
		const { db } = await openPglite();
		host = await devHost(artifact, db, { port, pack: readPack(join(root, '.norbital/seed/sample')), founder: 'boss@acme.example',
			files: localFiles(join(scratch, 'files')), log: () => {} });
	}, 60_000);
	afterAll(async () => { await host?.close(); });

	const cookies: string[] = [];
	const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
		const r = await fetch(`${host.url}${path}`, { method: body === undefined ? 'GET' : 'POST',
			headers: { 'content-type': 'application/json', cookie: cookies.join('; '), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		for (const c of r.headers.getSetCookie()) cookies.push(c.split(';')[0]!);
		return r;
	};

	it('signs the founder in with the dev sink code and reads the seeded rows', async () => {
		expect((await call('/__bolt/session/code', { email: 'boss@acme.example' })).status).toBe(200);
		expect((await call('/__bolt/session/verify', { email: 'boss@acme.example', code: '123456' })).status).toBe(200);
		const q = await (await call('/__bolt/q', { reads: [{ m: 'read', a: ['customers', { all: true }] }] })).json() as { answers: { rows: { name: string }[] }[] };
		expect(q.answers[0]!.rows.map((r) => r.name)).toEqual(['Bank Co']);
		const act = await call('/__bolt/act', { callable: 'customers.create', input: { name: 'New' }, issuedAt: new Date().toISOString() }, { 'Idempotency-Key': randomUUID() });
		expect(((await act.json()) as { outcome: { kind: string } }).outcome.kind).toBe('committed');
	});

	it('seeded the bank teams and queued the first-admission start run (rule 70)', async () => {
		const [teams, runs] = await host.engine().db.read([{ text: 'SELECT id, parent FROM sys_team ORDER BY id', params: [] },
			{ text: `SELECT automation, cause FROM sys_run WHERE cause = 'start'`, params: [] }]);
		expect(teams!.rows).toEqual([{ id: 't1', parent: null }, { id: 't2', parent: 't1' }]);
		expect(runs!.rows).toEqual([{ automation: 'nightly', cause: 'start' }]);
	});

	it('put the pack assets in the files store as FileRefs (rule 70)', async () => {
		const [r] = await host.engine().db.read([{ text: `SELECT c.logo, f.key, f.field FROM customers c JOIN sys_file f ON f.id = c.logo->>'id'`, params: [] }]);
		expect(r!.rows[0]).toMatchObject({ logo: { name: 'bank.png', mime: 'image/png' }, field: 'customers.logo' });
		expect(readFileSync(join(scratch, 'files', String(r!.rows[0]!['key'])), 'utf8')).toBe('PNG bytes');
	});

	it('serves the client document on app paths and its chunks', async () => {
		const html = await (await call('/app/sales/board')).text();
		const entry = /src="\/(assets\/[^"]+\.js)"/.exec(html)![1]!;
		const js = await call(`/${entry}`);
		expect(js.status).toBe(200);
		expect(js.headers.get('content-type')).toBe('text/javascript');
		expect((await call('/__bolt/nope')).status).toBe(404);
		expect(await (await call('/assets/thumbnail.svg')).text()).toBe('<svg/>'); // the artifact's workspace assets
	});

	it('hot-swaps a rebuilt activation onto the same database', async () => {
		const model = join(root, 'src/data/model/customers/+model.ts');
		writeFileSync(model, readFileSync(model, 'utf8').replace("name: { kind: 'text' },", "name: { kind: 'text' }, city: { kind: 'text', optional: true },"));
		const { artifact } = await buildWorkspace(root, { types: false });
		await host.swap(readArtifact(artifact.dir));
		const q = await (await call('/__bolt/q', { reads: [{ m: 'read', a: ['customers', { all: true }] }] })).json() as { answers: { rows: { name: string; city: null }[] }[] };
		expect(q.answers[0]!.rows).toHaveLength(2);
		expect(q.answers[0]!.rows[0]).toHaveProperty('city', null);
	}, 60_000);
});
