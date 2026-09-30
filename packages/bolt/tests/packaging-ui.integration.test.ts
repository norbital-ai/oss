/// <reference types="node" />
// Packaging gaps found migrating the 0.0.1 templates, on PGlite: a restore fills a column's default for a key a row
// omits (rule 70); `/runs` lists a holder's runs as rule 56 lets them read them; `testWorkspace({ seed })` takes the
// named packs, and the base pack goes through `seed/seed.ts`; the client build loads representations lazily, hands
// custom field renderers to the shell and keeps pages on the shell's one `@norbital-ai/ui`.
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Authority, EngineManifest } from '../src/engine/contracts.ts';
import { runList } from '../src/shell/data.ts';
import { testWorkspace } from '../src/test/index.ts';
import { check } from '../src/compiler/check/index.ts';
import { discover } from '../src/compiler/discover.ts';
import { buildClient } from '../src/compiler/artifact/client.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { loadKeys } from '../src/engine/identity/session.ts';
import { devTurnstile, shellHost } from '../src/shell/host.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', apps: [] },
	models: { jobs: { description: 'Jobs', label: 'title', fields: { title: { kind: 'text' }, status: { kind: 'enum', values: ['open', 'closed'], default: 'open' } } } },
	relationships: {}, collections: { jobs: { read: { fields: 'all' } } }, integrations: {}, pipelines: {}, policies: {}, apps: {},
	teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

describe('seed restore', () => {
	it('gives a key a row omits its column default, not null', async () => {
		const t = await testWorkspace({ manifest, seed: { jobs: [{ id: randomUUID(), title: 'A', status: 'closed' }, { id: randomUUID(), title: 'B' }] } });
		const [r] = await t.db.read([{ text: 'SELECT title, status FROM jobs ORDER BY title', params: [] }]);
		expect(r!.rows).toEqual([{ title: 'A', status: 'closed' }, { title: 'B', status: 'open' }]);
	});
});

describe('/runs', () => {
	it('lists a holder\'s runs of one automation in full, and a causing member\'s with the error code only', async () => {
		const t = await testWorkspace({ manifest });
		const run = (automation: string, actor: string) => t.db.write({ text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, actor, state, error)
			VALUES ($1, $2, '{}', now(), 'start', 0, $3, 'failed', '{"code":"invalid","message":"bad row 3"}')`, params: [randomUUID(), automation, actor] });
		await run('export', 'member:u9');
		await run('export', 'member:u2');
		await run('import', 'member:u9');
		const who = (id: string, automations: string[], external: boolean): Authority => ({ key: id, admin: false, policies: [], collections: {}, automations, limits: [], teamTree: [], scopes: {},
			actor: { kind: 'member', id, email: null, phone: null, external, teams: [], teamPath: [], admin: false, party: null }, capabilities: { apps: [], tools: [], mcp: [], skills: [] } }) as never;
		const holder = await runList(t.db, who('u1', ['export'], true), 10, 'export');
		expect(holder.map((r) => [r.automation, r.error])).toEqual([['export', { code: 'invalid', message: 'bad row 3' }], ['export', { code: 'invalid', message: 'bad row 3' }]]);
		expect(await runList(t.db, who('u2', [], false), 10)).toEqual([expect.objectContaining({ automation: 'export', status: 'failed', error: { code: 'invalid' } })]);
	});
});

describe('the page organization', () => {
	it('boots with the workspace name and the host\'s brand logo, which pages read as bolt.org', async () => {
		const site = { ...manifest, apps: { site: { title: 'Site', description: 'd', icon: 'i', audience: { public: ['guest'] }, pages: { home: { title: 'Home' } } } },
			policies: { guest: { description: 'Visitors', grants: {} } } } as unknown as EngineManifest;
		const t = await testWorkspace({ manifest: site });
		const identity = { db: t.db, now: () => new Date(t.clock.now()), windows: new RateWindows(), keys: await loadKeys(t.db),
			mail: { send: async () => ({ providerId: 'x' }), subscribe: () => () => {} }, devSink: true, publicUrl: 'https://acme.example' };
		const shell = shellHost({ manifest: site, identity, authorities: new Authorities(site, 'test'), ip: () => '203.0.113.9', turnstile: devTurnstile, ai: false,
			workspace: { name: 'Acme', handle: 'acme', icons: [{ src: '/assets/logo.svg', sizes: 'any', type: 'image/svg+xml' }] } } as never);
		const res = await shell.handle(new Request('https://acme.example/__bolt/shell?app=site'));
		expect((await res!.json() as { value: { workspace: unknown } }).value.workspace).toMatchObject({ name: 'Acme', logo: '/assets/logo.svg' });
	});
});

const FIXTURE = fileURLToPath(new URL('./fixtures/good', import.meta.url));
const scratch = join(tmpdir(), 'norbital-scratch', `packaging-${randomUUID()}`);
const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function copy(name: string): string {
	const root = join(scratch, name);
	cpSync(FIXTURE, root, { recursive: true, filter: (p) => !p.includes('.norbital') });
	for (const f of readdirSync(join(root, 'src'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts'))) {
		const p = join(root, 'src', f);
		writeFileSync(p, readFileSync(p, 'utf8').replace(/'(\.\.\/)+src\/index\.ts'/g, "'@norbital-ai/bolt'"));
	}
	write(join(root, 'tsconfig.json'), '{}');
	return root;
}

describe('testWorkspace seed', () => {
	it('builds the base pack through seed/seed.ts, restores none on request, and needs a built sample', async () => {
		const root = copy('seeded');
		write(join(root, 'seed/seed.ts'), `export default { bank: 'acme',
	rows: (bank) => ({ customers: [{ id: '0199a000-0000-4000-8000-0000000000c1', name: bank.has('customers.json') ? 'Bank' : 'Public' }] }) };`);
		const base = await testWorkspace({ root });
		expect((await base.as(base.admin).read('customers', { limit: 10 })).rows.map((r) => r['name'])).toEqual(['Public']);
		const none = await testWorkspace({ root, seed: 'none' });
		expect((await none.as(none.admin).read('customers', { limit: 10 })).rows).toEqual([]);
		await expect(testWorkspace({ root, seed: 'sample' })).rejects.toThrow('bolt build --bank');
	}, 60_000);
});

describe('the client build', () => {
	it('loads representations on first use, registers custom field renderers, and resolves @norbital-ai/ui to the shell copy', async () => {
		const root = copy('client');
		write(join(root, 'src/app/sales/+board.page.svelte'), `<script lang="ts">import { Table } from '@norbital-ai/ui';</script>\n<Table of="customers" columns={['name']} />\n`);
		const c = await check(root);
		expect(c.errors).toEqual([]);
		const out = join(root, '.norbital', 'artifact', 'client');
		const { entry } = await buildClient(root, discover(root).files, c.manifest!, out, 'Good');
		const html = readFileSync(join(out, 'index.html'), 'utf8');
		expect(html).toContain('id="bolt-loading" role="status"');
		expect(html).toContain('Opening workspace…');
		const js = readFileSync(join(out, entry), 'utf8');
		expect(js).toMatch(/representations:\{orders:\(\)=>/);
		expect(js).toMatch(/customFields:\{rating:\{shape:\{/);
		// the representation is a chunk of its own, loaded by the registry
		const chunks = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'));
		expect(js.includes('<p>order</p>')).toBe(false);
		expect(chunks.some((f) => readFileSync(join(out, 'assets', f), 'utf8').includes('<p>order</p>'))).toBe(true);
		// one ui: no chunk carries a second copy of the views' context module
		const copies = chunks.filter((f) => readFileSync(join(out, 'assets', f), 'utf8').includes('A view needs the shell: call provideBolt(bolt) above it.'));
		expect(copies.length).toBe(1);
	}, 120_000);
});
