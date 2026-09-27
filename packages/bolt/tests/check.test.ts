/// <reference types="node" />
// `bolt check` (rule 7): stage order, every error in one run, isolate evaluation (rule 2), guest walls (rule 6) and the
// build checks of §3.3.9 (model/range, model/seq, automation/cron, approval/steps, automation/event-input,
// access/ip-limit, access/limit, access/visitor-grant, access/visitor-ref, access/masked-search, access/write-many, access/internal-unreachable).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { check } from '../src/compiler/check/index.ts';
import { cronValid } from '../src/compiler/check/rules.ts';

const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
/** A workspace directory under the scratch root, from `path → source`. */
function workspace(files: { [path: string]: string }): string {
	const root = join(tmpdir(), 'norbital-scratch', `check-${randomUUID()}`);
	made.push(root);
	for (const [p, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, p)), { recursive: true });
		writeFileSync(join(root, p), text);
	}
	return root;
}

const GOOD = {
	'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
	'src/data/model/orders/+model.ts': `import { model } from '@norbital-ai/bolt';
export default model({ description: 'Orders', label: 'title', fields: { title: { kind: 'text' },
	stamp: { kind: 'text', default: new Date().toISOString() }, luck: { kind: 'int', default: Math.floor(Math.random() * 1e9) } } });`,
	'src/data/collection/orders/+collection.ts': `import { collection } from '@norbital-ai/bolt';
const c = collection('orders', { read: { fields: 'all' }, create: { input: { columns: ['title'] } },
	queries: { count: { description: 'Count', input: {}, output: { kind: 'int' } } } });
c.transform(async (rows) => rows);
c.query('count', async (input, ctx) => (await ctx.read('orders', { all: true })).rows.length);
export default c;`,
	'src/access/+rep.policy.ts': `export default { description: 'Rep', grants: { orders: { read: true, create: true, queries: ['count'] } } };`,
	'src/automation/+nightly.automation.ts': `import { automation } from '@norbital-ai/bolt';
const a = automation({ description: 'Nightly', on: { cron: '0 2 * * 1-5' }, runAs: ['rep'] });
a.run(async () => {});
export default a;`,
	'seed/orders.json': JSON.stringify([{ id: '0199a000-0000-4000-8000-000000000001', title: 'seeded' }]),
};

describe('bolt check', () => {
	it('runs discover → names → bundle → evaluate → manifest → seed → schema → rules and compiles a clean workspace', async () => {
		const root = workspace(GOOD);
		const r = await check(root);
		expect(r.errors).toEqual([]);
		expect(r.stages).toEqual(['discover', 'names', 'bundle', 'evaluate', 'manifest', 'seed', 'schema', 'rules']);
		expect(r.transforms).toEqual(['orders']);
		expect(r.manifest!.models['orders']!.fields['stamp']).toMatchObject({ default: '2000-01-01T00:00:00.000Z' });
		expect(r.manifest!.automations['nightly']).toMatchObject({ runAs: ['rep'] });
		expect(r.seed).toEqual({ orders: [{ id: '0199a000-0000-4000-8000-000000000001', title: 'seeded' }] });
		expect(r.guest!.source).toContain('bodies');
		expect(existsSync(join(root, '.norbital/names.ts'))).toBe(true);
	});

	it('reports every error of every stage in one run', async () => {
		const r = await check(workspace({
			'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
			'src/+layout.ts': `export default 1;`,
			'src/lib/disk.ts': `import { readFileSync } from 'node:fs'; export const read = readFileSync;`,
			'src/data/+relationship.ts': `export default { 'applications.opening': { to: 'openings', inverse: 'applications' }, 'applications.source': { to: 'sources' } };`,
			'src/data/model/orders/+model.ts': `import { read } from '../../../lib/disk.ts'; void read;
export default { description: 'o', label: 'title', search: { text: ['title'] }, fields: { title: { kind: 'text' },
	v: { kind: 'vector', dim: 5000, metric: 'l2' }, n: { kind: 'seq', pattern: 'X-{abc}' },
	s: { kind: 'state', initial: 'nope', states: { a: {} } }, at: { kind: 'time', precision: 'month' } } };`,
			'src/data/model/openings/+model.ts': `export default { description: 'o', label: 'title', fields: { title: { kind: 'text' } } };`,
			'src/data/model/sources/+model.ts': `export default { description: 's', label: 'name', fields: { name: { kind: 'text' } } };`,
			'src/data/model/applications/+model.ts': `export default { description: 'a', label: 'name', fields: { name: { kind: 'text' } } };`,
			'src/data/collection/orders/+collection.ts': `export default { name: 'orders', spec: { read: { fields: 'all' }, create: { input: { columns: ['title'] } },
	actions: { hidden: { description: 'h', input: {}, internal: true } } } };`,
			'src/data/collection/openings/+collection.ts': `export default { name: 'openings', spec: { read: { fields: 'all' } } };`,
			'src/data/collection/sources/+collection.ts': `export default { name: 'sources', spec: { read: { fields: 'all' } } };`,
			'src/data/collection/applications/+collection.ts': `export default { name: 'applications', spec: { read: { fields: 'all' },
	create: { input: { columns: ['name', 'opening', 'source'] } }, update: { input: { columns: ['name'] } } } };`,
			'src/access/+rep.policy.ts': `export default { description: 'r', grants: { orders: { read: true,
	create: { approval: { steps: [['a'], ['a'], ['a'], ['a'], ['a'], ['a'], ['a'], ['a'], ['a']] } } } },
	limits: { act: { rate: '5/min', per: 'ip' }, read: '0/min' } };`,
			'src/access/+auditor.policy.ts': `export default { description: 'a', grants: { orders: { read: { fields: ['v'] } } } };`,
			'src/access/+applicant.policy.ts': `export default { description: 'v', grants: { applications: { create: true, update: true } } };`,
			'src/access/+kiosk.policy.ts': `export default { description: 'k', grants: { openings: { read: true } } };`,
			'src/access/+hirer.policy.ts': `export default { description: 'h', grants: { openings: { read: true, update: { where: { or: [{ title: { eq: 'x' } }, { applications: { some: {} } }] } } } } };`,
			'src/app/careers/+app.ts': `export default { name: 'careers', spec: { title: 'c', description: 'c', icon: 'x', audience: { public: ['applicant', 'kiosk'] }, pages: {} } };`,
			'src/automation/+tick.automation.ts': `export default { spec: { description: 't', on: [{ cron: '61 * * * *' }, { created: 'orders' }],
	input: { note: { kind: 'text' } }, runAs: ['rep'] } };`,
		}));
		const codes = [...new Set(r.errors.map((e) => e.code))].sort();
		expect(codes).toEqual([
			'access/internal-unreachable', 'access/ip-limit', 'access/limit', 'access/masked-search', 'access/visitor-grant', 'access/visitor-ref', 'access/write-many',
			'approval/steps', 'automation/cron', 'automation/event-input', 'automation/no-body', 'discover/unknown-role',
			'guest/node-import', 'model/precision', 'model/range', 'model/seq', 'model/state',
		]);
		expect(r.stages.at(-1)).toBe('rules');
		expect(r.errors.filter((e) => e.code === 'model/state').map((e) => e.message)).toContainEqual(expect.stringContaining("'a' is unreachable from 'nope'"));
		expect(r.errors.find((e) => e.code === 'guest/node-import')!.path).toBe('src/lib/disk.ts');
		expect(r.errors.find((e) => e.code === 'model/precision')!.message).toContain('at: a time takes precision hour, minute');
		expect(r.errors.find((e) => e.code === 'access/visitor-ref')!.message).toContain('applications.source');
		expect(r.errors.filter((e) => e.code === 'access/write-many').map((e) => e.message)).toEqual([expect.stringContaining("openings.update: a write grant cannot scope through the many-relation 'applications'")]);
		expect(r.errors.filter((e) => e.code === 'access/visitor-grant').map((e) => e.path).sort()).toEqual(['src/access/+applicant.policy.ts', 'src/access/+kiosk.policy.ts']);
	});

	it('evaluates declarations with the guest globals (rule 6)', async () => {
		const r = await check(workspace({ 'src/+workspace.ts': `const n = new TextEncoder().encode(new URL('https://a.test/x').href).length;
export default structuredClone({ tz: 'UTC', locale: 'en', n: n + new TextDecoder().decode(new Uint8Array([1])).length + typeof queueMicrotask.length });` }));
		expect(r.errors).toEqual([]);
	});

	it('bundles a `?bytes` import as a server asset by sha256, readable while declarations evaluate (§5.8, L-COL-099)', async () => {
		const r = await check(workspace({ 'lib/blob.bin': 'bytes\u0000!', 'src/+workspace.ts': `import blob from '../lib/blob.bin?bytes';
export default { tz: 'UTC', locale: 'en', n: blob.length };` }));
		expect(r.errors).toEqual([]);
		const sha = createHash('sha256').update('bytes\u0000!').digest('hex');
		expect(Object.keys(r.guest!.assets ?? {})).toEqual([sha]);
		expect(Buffer.from(r.guest!.assets![sha]!).toString()).toBe('bytes\u0000!');
		expect(r.guest!.source).toContain(sha);
	});

	it('writes the generated tsconfig before bundling, so a fresh checkout checks', async () => {
		const root = workspace({ 'tsconfig.json': JSON.stringify({ extends: './.norbital/tsconfig.json' }), 'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };` });
		expect((await check(root)).errors).toEqual([]);
		expect(existsSync(join(root, '.norbital/bolt.d.ts'))).toBe(true);
	});

	it('refuses module evaluation over 100 ms of CPU (rule 6)', async () => {
		const r = await check(workspace({ 'src/+workspace.ts': `let x = 0; for (let i = 0; i < 1e9; i++) x ^= i; export default { tz: 'UTC', locale: 'en', x: x & 0 };` }));
		expect(r.errors.map((e) => e.code)).toContain('guest/eval-cpu');
	});

	it('checks from the published build, where bolt is index.js', async () => {
		const built = await import(new URL('../build/compiler/check/index.js', import.meta.url).href) as { check: typeof check };
		expect((await built.check(workspace(GOOD))).errors.filter((e) => e.code === 'bundle/failed')).toEqual([]);
	});

	it('parses cron strings at build (rule 52)', () => {
		for (const ok of ['0 2 * * *', '*/15 * * * *', '0 9-17 * * 1-5', '5,35 0 1 1,6 0', '@daily']) expect(cronValid(ok)).toBe(true);
		for (const bad of ['61 * * * *', '* * * *', '0 0 0 * *', '*/0 * * * *', '0 0 * 13 *', '5-1 * * * *', '@often']) expect(cronValid(bad)).toBe(false);
	});
});
