/// <reference types="node" />
// `bolt check` (rule 7): stage order, every error in one run, isolate evaluation (rule 2), guest walls (rule 6) and the
// build checks of §3.3.9 (model/range, model/seq, automation/cron, approval/steps, automation/event-input,
// model/label, model/instant-date, access/ip-limit, access/limit, access/visitor-grant, access/visitor-ref, access/masked-search, access/write-many, access/internal-unreachable).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import ivm from 'isolated-vm';
import { PRELUDE } from '../src/engine/guest/prelude.ts';
import { assetHook, digest, randomStream } from '../src/engine/guest/runner.ts';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { check } from '../src/compiler/check/index.ts';
import { buildChecks, cronValid } from '../src/compiler/check/rules.ts';
import type { EngineManifest } from '../src/engine/contracts.ts';

const made: string[] = [];
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});
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
	'seed/orders.json': JSON.stringify([
		{ id: '0199a000-0000-4000-8000-000000000001', title: 'seeded' }
	])
};

describe('bolt check', () => {
	it('runs discover → names → bundle → evaluate → manifest → seed → schema → rules and compiles a clean workspace', async () => {
		const root = workspace(GOOD);
		const r = await check(root);
		expect(r.errors).toEqual([]);
		expect(r.stages).toEqual([
			'discover',
			'names',
			'bundle',
			'evaluate',
			'manifest',
			'seed',
			'schema',
			'rules'
		]);
		expect(r.transforms).toEqual(['orders']);
		expect(r.manifest!.models['orders']!.fields['stamp']).toMatchObject({
			default: '2000-01-01T00:00:00.000Z'
		});
		expect(r.manifest!.automations['nightly']).toMatchObject({ runAs: ['rep'] });
		expect(r.seed).toEqual({
			orders: [{ id: '0199a000-0000-4000-8000-000000000001', title: 'seeded' }]
		});
		expect(r.guest!.source).toContain('bodies');
		expect(existsSync(join(root, '.norbital/names.ts'))).toBe(true);
	});

	it('minifies guest bindings while preserving declarations, callable names, assets and original source positions', async () => {
		const files = { ...GOOD,
			'lib/blob.bin': 'bytes\u0000!',
			'src/data/collection/orders/+collection.ts': `import { collection } from '@norbital-ai/bolt';
import blob from '../../../../lib/blob.bin?bytes';
class OrderMarker {}
const c = collection('orders', { read: { fields: 'all' }, create: { input: { columns: ['title'] } }, queries: { count: { description: OrderMarker.name, input: {}, output: { kind: 'int' } } } });
async function transformOrders(rows) { return rows; }
async function countOrders() { return blob.length; }
c.transform(transformOrders); c.query('count', countOrders); export default c;`
		};
		const root = workspace(files);
		const result = await check(root);
		expect(result.errors).toEqual([]);
		expect(result.manifest).toEqual((await check(root)).manifest);
		expect(result.manifest!.collections['orders']!.queries!['count']!.description).toBe('OrderMarker');
		const map = new TraceMap(JSON.parse(result.guest!.sourceMap!));
		const source = result.guest!.source;
		const at = source.indexOf('function transformOrders');
		expect(at).toBeGreaterThan(-1);
		const prefix = source.slice(0, at);
		const position = originalPositionFor(map, { line: prefix.split('\n').length, column: prefix.length - prefix.lastIndexOf('\n') - 1 });
		expect(position.source).toContain('src/data/collection/orders/+collection.ts');
		expect(position.line).toBe(5);
		const isolate = new ivm.Isolate({ memoryLimit: 256 });
		try {
			const context = await isolate.createContext();
			await context.evalClosure(PRELUDE, [() => {}, randomStream('bolt:check'), digest, assetHook(result.guest!.assets)], { result: { reference: true } });
			const module = await isolate.compileModule(source);
			await module.instantiate(context, () => { throw new Error('unexpected external import'); });
			await module.evaluate({ timeout: 1000 });
			await context.global.set('__ns', module.namespace.derefInto());
			expect(await context.eval(`(async()=>{ const c=__ns.default.collection.orders; return { transformName:c.bodies.transform.name, queryName:c.bodies.queries.count.name, rows:await c.bodies.transform([{title:'kept'}]), count:await c.bodies.queries.count() }; })()`, { promise: true, copy: true })).toEqual({ transformName: 'transformOrders', queryName: 'countOrders', rows: [{ title: 'kept' }], count: 7 });
		} finally { isolate.dispose(); }
	});

	it('keeps dynamic-only module initialization at first invocation, once, with live repeated imports', async () => {
		const root = workspace({
			'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
			'src/lib/dynamic.ts': `export { value, increment } from './dynamic-dependency.ts';`,
			'src/lib/dynamic-dependency.ts': `globalThis.dynamicInitializations = (globalThis.dynamicInitializations ?? 0) + 1;
export let value = 0;
export function increment() { value += 1; }`,
			'src/automation/+a.automation.ts': `import { automation } from '@norbital-ai/bolt';
const a = automation({ description: 'Dynamic', on: { cron: '0 0 * * *' } });
async function dynamicBody() {
 const before = globalThis.dynamicInitializations ?? 0;
 const first = await import('../lib/dynamic.ts');
 first.increment();
 const second = await import('../lib/dynamic.ts');
 return { before, after: globalThis.dynamicInitializations, same: first === second, first: first.value, second: second.value };
}
a.run(dynamicBody); export default a;`
		});
		const result = await check(root);
		expect(result.errors).toEqual([]);
		const isolate = new ivm.Isolate({ memoryLimit: 256 });
		try {
			const context = await isolate.createContext();
			await context.evalClosure(PRELUDE, [() => {}, randomStream('bolt:check'), digest, assetHook(result.guest!.assets)], { result: { reference: true } });
			const module = await isolate.compileModule(result.guest!.source);
			await module.instantiate(context, () => { throw new Error('unexpected external import'); });
			await module.evaluate({ timeout: 1000 });
			expect(await context.eval('globalThis.dynamicInitializations ?? 0', { copy: true })).toBe(0);
			await context.global.set('__ns', module.namespace.derefInto());
			const invoke = () => context.eval('__ns.default.automation.a.body()', { promise: true, copy: true });
			expect(await invoke()).toEqual({ before: 0, after: 1, same: true, first: 1, second: 1 });
			expect(await invoke()).toEqual({ before: 1, after: 1, same: true, first: 2, second: 2 });
		} finally { isolate.dispose(); }
	});

	it('reports every error of every stage in one run', async () => {
		const r = await check(
			workspace({
				'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
				'src/+layout.ts': `export default 1;`,
				'src/lib/disk.ts': `import { readFileSync } from 'node:fs'; export const read = readFileSync;`,
				'src/data/+relationship.ts': `export default { 'applications.opening': { to: 'openings', inverse: 'applications' }, 'applications.source': { to: 'sources' } };`,
				'src/data/model/orders/+model.ts': `import { read } from '../../../lib/disk.ts'; void read;
export default { description: 'o', label: 'title', search: { text: ['title'], semantic: { fields: ['title'], model: 'default' } }, fields: { title: { kind: 'text' },
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
	input: { note: { kind: 'text' } }, runAs: ['rep'] } };`
			})
		);
		const codes = [...new Set(r.errors.map((e) => e.code))].sort();
		expect(codes).toEqual([
			'access/internal-unreachable',
			'access/ip-limit',
			'access/limit',
			'access/masked-search',
			'access/visitor-grant',
			'access/visitor-ref',
			'access/write-many',
			'approval/steps',
			'automation/cron',
			'automation/event-input',
			'automation/no-body',
			'discover/unknown-role',
			'guest/node-import',
			'model/precision',
			'model/range',
			'model/seq',
			'model/state'
		]);
		expect(r.stages.at(-1)).toBe('rules');
		expect(r.errors.filter((e) => e.code === 'model/state').map((e) => e.message)).toContainEqual(
			expect.stringContaining("'a' is unreachable from 'nope'")
		);
		expect(r.errors.find((e) => e.code === 'guest/node-import')!.path).toBe('src/lib/disk.ts');
		expect(r.errors.find((e) => e.code === 'model/precision')!.message).toContain(
			'at: a time takes precision hour, minute'
		);
		expect(r.errors.filter((e) => e.code === 'model/range').map((e) => e.message)).toEqual([
			expect.stringContaining('v: vector dim is 1 to 2,000'),
			expect.stringContaining("search.semantic: dim is 1 to 2,000 (the embedding column's width")
		]);
		expect(r.errors.find((e) => e.code === 'access/visitor-ref')!.message).toContain(
			'applications.source'
		);
		expect(r.errors.filter((e) => e.code === 'access/write-many').map((e) => e.message)).toEqual([
			expect.stringContaining(
				"openings.update: a write grant cannot scope through the many-relation 'applications'"
			)
		]);
		expect(
			r.errors
				.filter((e) => e.code === 'access/visitor-grant')
				.map((e) => e.path)
				.sort()
		).toEqual(['src/access/+applicant.policy.ts', 'src/access/+kiosk.policy.ts']);
	});

	it('evaluates declarations with the guest globals (rule 6)', async () => {
		const r = await check(
			workspace({
				'src/+workspace.ts': `const n = new TextEncoder().encode(new URL('https://a.test/x').href).length;
export default structuredClone({ tz: 'UTC', locale: 'en', n: n + new TextDecoder().decode(new Uint8Array([1])).length + typeof queueMicrotask.length });`
			})
		);
		expect(r.errors).toEqual([]);
	});

	it('bundles a `?bytes` import as a server asset by sha256, readable while declarations evaluate (§5.8, L-COL-099)', async () => {
		const r = await check(
			workspace({
				'lib/blob.bin': 'bytes\u0000!',
				'src/+workspace.ts': `import blob from '../lib/blob.bin?bytes';
export default { tz: 'UTC', locale: 'en', n: blob.length };`
			})
		);
		expect(r.errors).toEqual([]);
		const sha = createHash('sha256').update('bytes\u0000!').digest('hex');
		expect(Object.keys(r.guest!.assets ?? {})).toEqual([sha]);
		expect(Buffer.from(r.guest!.assets![sha]!).toString()).toBe('bytes\u0000!');
		expect(r.guest!.source).toContain(sha);
	});

	it('writes the generated tsconfig before bundling, so a fresh checkout checks', async () => {
		const root = workspace({
			'tsconfig.json': JSON.stringify({ extends: './.norbital/tsconfig.json' }),
			'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`
		});
		expect((await check(root)).errors).toEqual([]);
		expect(existsSync(join(root, '.norbital/bolt.d.ts'))).toBe(true);
	});

	it('refuses module evaluation over 100 ms of CPU (rule 6)', async () => {
		const r = await check(
			workspace({
				'src/+workspace.ts': `let x = 0; for (let i = 0; i < 1e9; i++) x ^= i; export default { tz: 'UTC', locale: 'en', x: x & 0 };`
			})
		);
		expect(r.errors.map((e) => e.code)).toContain('guest/eval-cpu');
	});

	it('checks from the published build, where bolt is index.js', async () => {
		const built = (await import(
			new URL('../build/compiler/check/index.js', import.meta.url).href
		)) as { check: typeof check };
		expect(
			(await built.check(workspace(GOOD))).errors.filter((e) => e.code === 'bundle/failed')
		).toEqual([]);
	});

	it('refuses a label naming an id or a foreign key, and an instant named as a calendar day (model/label, model/instant-date)', () => {
		const m = {
			workspace: {},
			models: {
				lines: {
					label: ['order', 'title'],
					fields: {
						title: { kind: 'text' },
						shipped_on: { kind: 'instant' },
						due_date: { kind: 'instant' },
						paid_at: { kind: 'instant' },
						born_on: { kind: 'date' }
					}
				},
				orders: { label: 'id', fields: {} },
				notes: {
					label: 'code',
					fields: {},
					computed: { code: { kind: 'text', expr: { field: 'id' } } }
				}
			},
			relationships: { 'lines.order': { to: 'orders' } },
			automations: {},
			apps: {},
			policies: {},
			collections: {}
		} as unknown as EngineManifest;
		const found = buildChecks(m, { automations: [] }, (_r, n) => n).map(
			(f) => `${f.code} ${f.message}`
		);
		expect(found).toEqual([
			"model/instant-date lines: shipped_on: a field named *_on or *_date is a calendar day; declare it { kind: 'date' }",
			"model/instant-date lines: due_date: a field named *_on or *_date is a calendar day; declare it { kind: 'date' }",
			expect.stringContaining("model/label lines: label 'order' is a foreign key"),
			expect.stringContaining("model/label orders: label 'id' is the row id")
		]);
	});

	it('rejects personal channel outbound and envoys while allowing provider-defined transports', () => {
		const m = {
			workspace: {},
			models: {},
			relationships: {},
			automations: {},
			apps: {},
			policies: {},
			collections: {},
			connections: {},
			channels: {
				sent: { transport: 'email', syncOnly: true, outbound: {} },
				answered: { transport: 'whatsapp', syncOnly: true },
				provider_defined: { transport: 'slack', accounts: true, syncOnly: true },
				multiple_envoy: { transport: 'telegram', accounts: true },
				custom_sync: { transport: 'custom', accounts: true, syncOnly: true, inbound: { verify: { scheme: 'bearer', secret: 'token' }, messages: true } }
			},
			envoys: { agent: { channel: 'answered' }, invalid: { channel: 'multiple_envoy' } }
		} as unknown as EngineManifest;
		expect(
			buildChecks(m, { automations: [], connects: ['custom_sync'] }, (_r, n) => n)
				.filter((f) => f.code.startsWith('channel/'))
				.map((f) => f.code + ' ' + f.path)
		).toEqual([
			'channel/sync-only sent',
			'channel/sync-only answered',
			'channel/accounts-envoy multiple_envoy'
		]);
	});

	it('refuses a custom channel without its connect page or its send connection, and send on a provider channel (channel/*)', () => {
		const m = {
			workspace: {},
			models: {},
			relationships: {},
			automations: {},
			apps: {},
			policies: {},
			collections: {},
			connections: { partner_api: { baseUrl: 'PARTNER_URL' } },
			channels: {
				partner: { transport: 'custom', send: 'partner_api' },
				bare: { transport: 'custom' },
				desk: { transport: 'slack', send: 'partner_api' }
			}
		} as unknown as EngineManifest;
		const found = buildChecks(m, { automations: [], connects: ['partner'] }, (_r, n) => n).map(
			(f) => f.code + ' ' + f.path
		);
		expect(found).toEqual([
			'channel/custom-send bare',
			'channel/custom-connect bare',
			'channel/send desk'
		]);
		expect(
			buildChecks(m, { automations: [], connects: ['partner', 'bare'] }, (_r, n) => n).map(
				(f) => f.code
			)
		).not.toContain('channel/custom-connect');
	});

	it("checks a custom channel's inbound webhook and poll; a provider channel declares neither (channel/*)", () => {
		const m = {
			workspace: {},
			models: {},
			relationships: {},
			automations: {},
			apps: {},
			policies: {},
			collections: {},
			connections: { api: { baseUrl: 'API_URL' } },
			channels: {
				good: {
					transport: 'custom',
					send: 'api',
					inbound: { verify: { scheme: 'hmac-sha256', secret: 'signingSecret' }, messages: true },
					poll: { connection: 'api', cron: '*/5 * * * *', path: '/messages', messages: true }
				},
				bad: {
					transport: 'custom',
					send: 'api',
					inbound: { verify: { scheme: 'md5', secret: '' } },
					poll: { connection: 'nope', cron: 'often' }
				},
				desk: {
					transport: 'slack',
					inbound: { verify: { scheme: 'slack', secret: 's' }, messages: true }
				}
			}
		} as unknown as EngineManifest;
		const found = buildChecks(m, { automations: [], connects: ['good', 'bad'] }, (_r, n) => n).map(
			(f) => f.code + ' ' + f.path
		);
		expect(found).toEqual([
			'channel/inbound-verify bad',
			'channel/inbound-messages bad',
			'channel/poll-connection bad',
			'channel/poll-cron bad',
			'channel/poll-path bad',
			'channel/poll-messages bad',
			'channel/custom-inbound desk'
		]);
	});

	it('parses cron strings at build (rule 52)', () => {
		for (const ok of ['0 2 * * *', '*/15 * * * *', '0 9-17 * * 1-5', '5,35 0 1 1,6 0', '@daily'])
			expect(cronValid(ok)).toBe(true);
		for (const bad of [
			'61 * * * *',
			'* * * *',
			'0 0 0 * *',
			'*/0 * * * *',
			'0 0 * 13 *',
			'5-1 * * * *',
			'@often'
		])
			expect(cronValid(bad)).toBe(false);
	});
});
