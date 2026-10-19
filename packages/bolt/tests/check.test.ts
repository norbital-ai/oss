import { Effect, Schema } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
/// <reference types="node" />
// `bolt check` (rule 7): stage order, every error in one run, isolate evaluation (rule 2), guest walls (rule 6) and the
// build checks of §3.3.9 (model/range, model/seq, automation/cron, approval/steps, automation/event-input,
// model/label, model/instant-date, access/ip-limit, access/limit, access/visitor-grant, access/visitor-ref, access/masked-search, access/write-many, access/internal-unreachable).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import ivm from 'isolated-vm';
import { PRELUDE } from '../src/engine/guest/prelude.ts';
import { assetHook, digest, randomStream } from '../src/engine/guest/runner.ts';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { check } from '../src/compiler/check/index.ts';
import { checkRules, cronValid } from '../src/compiler/check/rules.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
const emptyManifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	collections: {},
	integrations: {},
	pipelines: {},
	policies: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const made: string[] = [];
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});
/** A workspace directory under the scratch root, from `path → source`. */
function workspace(files: { [path: string]: string }): string {
	const root = join(tmpdir(), 'norbital-scratch', `check-${randomUUID()}`);
	made.push(root);
	mkdirSync(root, { recursive: true });
	symlinkSync(
		fileURLToPath(new URL('../node_modules', import.meta.url)),
		join(root, 'node_modules'),
		'dir'
	);
	for (const [p, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, p)), { recursive: true });
		writeFileSync(join(root, p), text);
	}
	return root;
}
const GOOD = {
	'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
	'src/data/model/+orders.model.ts': `import { model } from '@norbital-ai/bolt';
export default model({ description: 'Orders', label: 'title', fields: { title: { kind: 'text' },
	stamp: { kind: 'text', default: new Date().toISOString() }, luck: { kind: 'int', default: Math.floor(Math.random() * 1e9) } } });`,
	'src/data/collection/orders/+collection.ts': `import { collection } from '@norbital-ai/bolt';
const c = collection('orders', { read: { fields: 'all' }, create: { input: { columns: ['title'] } },
	queries: { count: { description: 'Count', input: {}, output: { kind: 'int' } } } });
c.transform(function* (rows) { return rows; });
c.query('count', function* (input, ctx) { return (yield* ctx.read('orders', { all: true })).rows.length; });
export default c;`,
	'src/access_control/policy/+rep.policy.ts': `export default { description: 'Rep', grants: { orders: { read: true, create: true, queries: ['count'] } } };`,
	'src/automation/+nightly.automation.ts': `import { automation } from '@norbital-ai/bolt';
const a = automation({ description: 'Nightly', on: { cron: '0 2 * * 1-5' }, runAs: ['rep'] });
a.run(function* () {});
export default a;`,
	'seed/orders.json': JSON.stringify([
		{ id: '0199a000-0000-4000-8000-000000000001', title: 'seeded' }
	])
};
describe('bolt check', () => {
	it.live(
		'runs discover → names → bundle → evaluate → manifest → seed → schema → rules and compiles a clean workspace',
		() =>
			Effect.gen(function* () {
				const root = workspace(GOOD);
				const r = yield* check(root);
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
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'validates full declaration metadata before omitting unused data from the runtime guest',
		() =>
			Effect.gen(function* () {
				const files = {
					...GOOD,
					'src/data/model/+orders.model.ts': `export default { description: 'compile_only_model_marker', label: 'title', fields: { title: { kind: 'text' } } };`,
					'src/i18n/+messages.ts': `export default { 'orders.title': 'compile_only_base_message_marker' };`,
					'src/i18n/+zh.messages.ts': `export default { 'orders.title': 'compile_only_locale_marker' };`
				};
				const result = yield* check(workspace(files));
				expect(result.errors).toEqual([]);
				expect(result.manifest?.models['orders']?.description).toBe('compile_only_model_marker');
				for (const marker of [
					'compile_only_model_marker',
					'compile_only_base_message_marker',
					'compile_only_locale_marker'
				])
					expect(result.guest?.source).not.toContain(marker);
				const invalid = yield* check(
					workspace({
						...files,
						'src/data/model/+orders.model.ts': files['src/data/model/+orders.model.ts'].replace(
							"label: 'title'",
							"label: 'id'"
						)
					})
				);
				expect(invalid.errors.some((error) => error.code === 'model/label')).toBe(true);
				expect(invalid.guest?.source).toContain('compile_only_model_marker');
				expect(invalid.guest?.source).toContain('compile_only_locale_marker');
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'minifies guest bindings while preserving declarations, callable names, assets and original source positions',
		() =>
			Effect.gen(function* () {
				const files = {
					...GOOD,
					'src/+workspace.ts': `globalThis.roleInitialization = ['workspace'];\n${GOOD['src/+workspace.ts']}`,
					'src/data/model/+orders.model.ts': `globalThis.roleInitialization.push('model');\n${GOOD['src/data/model/+orders.model.ts']}`,
					'src/i18n/+messages.ts': `globalThis.roleInitialization.push('messages'); export default { 'orders.title': 'Orders' };`,
					'src/i18n/+zh.messages.ts': `globalThis.roleInitialization.push('locale'); export default { 'orders.title': '订单' };`,
					'lib/blob.bin': 'bytes\u0000!',
					'src/data/collection/orders/+collection.ts': `import { collection } from '@norbital-ai/bolt';
import blob from '../../../../lib/blob.bin?bytes';
class OrderMarker {}
const c = collection('orders', { read: { fields: 'all' }, create: { input: { columns: ['title'] } }, queries: { count: { description: OrderMarker.name, input: {}, output: { kind: 'int' } } } });
function* transformOrders(rows) { return rows; }
function* countOrders() { return blob.length; }
c.transform(transformOrders); c.query('count', countOrders); export default c;`
				};
				const root = workspace(files);
				const result = yield* check(root);
				expect(result.errors).toEqual([]);
				expect(result.manifest).toEqual((yield* check(root)).manifest);
				expect(result.manifest!.collections['orders']!.queries!['count']!.description).toBe(
					'OrderMarker'
				);
				const map = new TraceMap(JSON.parse(result.guest!.sourceMap!));
				const source = result.guest!.source;
				const at = /function\s*\*\s*transformOrders\b/.exec(source)?.index ?? -1;
				expect(at).toBeGreaterThan(-1);
				const prefix = source.slice(0, at);
				const position = originalPositionFor(map, {
					line: prefix.split('\n').length,
					column: prefix.length - prefix.lastIndexOf('\n') - 1
				});
				expect(position.source).toContain('src/data/collection/orders/+collection.ts');
				expect(position.line).toBe(5);
				const isolate = new ivm.Isolate({ memoryLimit: 256 });
				try {
					const context = yield* Effect.tryPromise({
						try: () => isolate.createContext(),
						catch: (cause) => new TestFailure({ cause })
					});
					yield* Effect.tryPromise({
						try: () =>
							context.evalClosure(
								PRELUDE,
								[() => {}, randomStream('bolt:check'), digest, assetHook(result.guest!.assets)],
								{ result: { reference: true } }
							),
						catch: (cause) => new TestFailure({ cause })
					});
					const module = yield* Effect.tryPromise({
						try: () => isolate.compileModule(source),
						catch: (cause) => new TestFailure({ cause })
					});
					yield* Effect.tryPromise({
						try: () =>
							module.instantiate(context, () => {
								throw new Error('unexpected external import');
							}),
						catch: (cause) => new TestFailure({ cause })
					});
					yield* Effect.tryPromise({
						try: () => module.evaluate({ timeout: 1000 }),
						catch: (cause) => new TestFailure({ cause })
					});
					yield* Effect.tryPromise({
						try: () => context.global.set('__ns', module.namespace.derefInto()),
						catch: (cause) => new TestFailure({ cause })
					});
					expect(
						yield* Effect.tryPromise({
							try: () =>
								context.eval(
									`(async()=>{ const c=__ns.default.collection.orders; return { transformName:c.bodies.transform.name, queryName:c.bodies.queries.count.name, rows:await c.bodies.transform([{title:'kept'}]), count:await c.bodies.queries.count(), initialized:globalThis.roleInitialization, roles:Object.keys(__ns.default).sort() }; })()`,
									{ promise: true, copy: true }
								),
							catch: (cause) => new TestFailure({ cause })
						})
					).toEqual({
						transformName: 'transformOrders',
						queryName: 'countOrders',
						rows: [{ title: 'kept' }],
						count: 7,
						initialized: ['workspace', 'model', 'messages', 'locale'],
						roles: ['automation', 'collection']
					});
				} finally {
					isolate.dispose();
				}
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'keeps dynamic-only module initialization at first invocation, once, with live repeated imports',
		() =>
			Effect.gen(function* () {
				const root = workspace({
					'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
					'src/lib/dynamic.ts': `export { value, increment } from './dynamic-dependency.ts';`,
					'src/lib/dynamic-dependency.ts': `globalThis.dynamicInitializations = (globalThis.dynamicInitializations ?? 0) + 1;
export let value = 0;
export function increment() { value += 1; }`,
					'src/automation/+a.automation.ts': `import { automation } from '@norbital-ai/bolt';
import { Effect } from 'effect';
import { Refusal } from ${JSON.stringify(fileURLToPath(new URL('../src/decl/errors.ts', import.meta.url)))};
const a = automation({ description: 'Dynamic', on: { cron: '0 0 * * *' } });
function* dynamicBody() {
 const before = globalThis.dynamicInitializations ?? 0;
 const first = yield* Effect.tryPromise({ try: () => import('../lib/dynamic.ts'), catch: () => new Refusal({ message: 'dynamic import failed' }) });
 first.increment();
 const second = yield* Effect.tryPromise({ try: () => import('../lib/dynamic.ts'), catch: () => new Refusal({ message: 'dynamic import failed' }) });
 return { before, after: globalThis.dynamicInitializations, same: first === second, first: first.value, second: second.value };
}
a.run(dynamicBody); export default a;`
				});
				const result = yield* check(root);
				expect(result.errors).toEqual([]);
				const isolate = new ivm.Isolate({ memoryLimit: 256 });
				try {
					const context = yield* Effect.tryPromise({
						try: () => isolate.createContext(),
						catch: (cause) => new TestFailure({ cause })
					});
					yield* Effect.tryPromise({
						try: () =>
							context.evalClosure(
								PRELUDE,
								[() => {}, randomStream('bolt:check'), digest, assetHook(result.guest!.assets)],
								{ result: { reference: true } }
							),
						catch: (cause) => new TestFailure({ cause })
					});
					const module = yield* Effect.tryPromise({
						try: () => isolate.compileModule(result.guest!.source),
						catch: (cause) => new TestFailure({ cause })
					});
					yield* Effect.tryPromise({
						try: () =>
							module.instantiate(context, () => {
								throw new Error('unexpected external import');
							}),
						catch: (cause) => new TestFailure({ cause })
					});
					yield* Effect.tryPromise({
						try: () => module.evaluate({ timeout: 1000 }),
						catch: (cause) => new TestFailure({ cause })
					});
					expect(
						yield* Effect.tryPromise({
							try: () => context.eval('globalThis.dynamicInitializations ?? 0', { copy: true }),
							catch: (cause) => new TestFailure({ cause })
						})
					).toBe(0);
					yield* Effect.tryPromise({
						try: () => context.global.set('__ns', module.namespace.derefInto()),
						catch: (cause) => new TestFailure({ cause })
					});
					const invoke = () =>
						context.eval('__ns.default.automation.a.body()', { promise: true, copy: true });
					expect(
						yield* Effect.tryPromise({
							try: () => invoke(),
							catch: (cause) => new TestFailure({ cause })
						})
					).toEqual({ before: 0, after: 1, same: true, first: 1, second: 1 });
					expect(
						yield* Effect.tryPromise({
							try: () => invoke(),
							catch: (cause) => new TestFailure({ cause })
						})
					).toEqual({ before: 1, after: 1, same: true, first: 2, second: 2 });
				} finally {
					isolate.dispose();
				}
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('reports every error of every stage in one run', () =>
		Effect.gen(function* () {
			const r = yield* check(
				workspace({
					'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
					'src/+layout.ts': `export default 1;`,
					'src/lib/disk.ts': `import { readFileSync } from 'node:fs'; export const read = readFileSync;`,
					'src/data/+relationship.ts': `export default { 'applications.opening': { to: 'openings', inverse: 'applications' }, 'applications.source': { to: 'sources' } };`,
					'src/data/model/+orders.model.ts': `import { read } from '../../lib/disk.ts'; void read;
export default { description: 'o', label: 'title', search: { text: ['title'], semantic: { fields: ['title'], model: 'default' } }, fields: { title: { kind: 'text' },
	v: { kind: 'vector', dim: 5000, metric: 'l2' }, n: { kind: 'seq', pattern: 'X-{abc}' },
	s: { kind: 'state', initial: 'nope', states: { a: {} } }, at: { kind: 'time', precision: 'month' } } };`,
					'src/data/model/+openings.model.ts': `export default { description: 'o', label: 'title', fields: { title: { kind: 'text' } } };`,
					'src/data/model/+sources.model.ts': `export default { description: 's', label: 'name', fields: { name: { kind: 'text' } } };`,
					'src/data/model/+applications.model.ts': `export default { description: 'a', label: 'name', fields: { name: { kind: 'text' } } };`,
					'src/data/collection/orders/+collection.ts': `export default { name: 'orders', spec: { read: { fields: 'all' }, create: { input: { columns: ['title'] } },
	actions: { hidden: { description: 'h', input: {}, internal: true } } } };`,
					'src/data/collection/openings/+collection.ts': `export default { name: 'openings', spec: { read: { fields: 'all' } } };`,
					'src/data/collection/sources/+collection.ts': `export default { name: 'sources', spec: { read: { fields: 'all' } } };`,
					'src/data/collection/applications/+collection.ts': `export default { name: 'applications', spec: { read: { fields: 'all' },
	create: { input: { columns: ['name', 'opening', 'source'] } }, update: { input: { columns: ['name'] } } } };`,
					'src/access_control/team/+team.ts': `export default { a: [] };`,
					'src/access_control/policy/+rep.policy.ts': `export default { description: 'r', grants: { orders: { read: true,
	approval: { create: { steps: [['a'], ['a'], ['a'], ['a'], ['a'], ['a'], ['a'], ['a'], ['a']] } } } },
	limits: { act: { rate: '5/min', per: 'ip' }, read: '0/min' } };`,
					'src/access_control/policy/+auditor.policy.ts': `export default { description: 'a', grants: { orders: { read: { fields: ['v'] } } } };`,
					'src/access_control/policy/+applicant.policy.ts': `export default { description: 'v', grants: { applications: { create: true, update: true } } };`,
					'src/access_control/policy/+kiosk.policy.ts': `export default { description: 'k', grants: { openings: { read: true } } };`,
					'src/access_control/policy/+hirer.policy.ts': `export default { description: 'h', grants: { openings: { read: true, update: { where: { or: [{ title: { eq: 'x' } }, { applications: { some: {} } }] } } } } };`,
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
			).toEqual([
				'src/access_control/policy/+applicant.policy.ts',
				'src/access_control/policy/+kiosk.policy.ts'
			]);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'checks a kiosk: its policies exist, auth is known, pages are listed, and an open kiosk holds visitor-shaped grants',
		() =>
			Effect.gen(function* () {
				const base = {
					'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
					'src/data/model/+openings.model.ts': `export default { description: 'o', label: 'title', fields: { title: { kind: 'text' } } };`,
					'src/data/collection/openings/+collection.ts': `export default { name: 'openings', spec: { read: { fields: 'all' },
				create: { input: { columns: ['title'] } }, update: { input: { columns: ['title'] } } } };`,
					'src/access_control/policy/+lobby.policy.ts': `export default { description: 'l', grants: { openings: {
				read: { where: {}, fields: ['id', 'title'] }, update: { where: {}, fields: ['title'] } } } };`
				};
				const bad = yield* check(
					workspace({
						...base,
						'src/kiosk/lobby/+kiosk.ts': `export default { name: 'lobby', spec: { title: 'L', description: 'L', icon: 'x',
				auth: 'none', policies: ['lobby', 'ghost'], pages: { welcome: { title: 'W' } } } };`,
						'src/kiosk/lobby/+welcome.page.svelte': `<p>hi</p>`,
						'src/kiosk/broken/+kiosk.ts': `export default { name: 'broken', spec: { title: 'B', description: 'B', icon: 'x',
				auth: 'anyone', policies: ['lobby'], pages: {} } };`
					})
				);
				const codes = [...new Set(bad.errors.map((e) => e.code))].sort();
				expect(codes).toEqual([
					'access/kiosk-grant',
					'app/page-server-required',
					'kiosk/auth',
					'kiosk/pages',
					'kiosk/policy'
				]);
				expect(bad.errors.find((e) => e.code === 'kiosk/policy')!.message).toContain("'ghost'");
				const good = yield* check(
					workspace({
						...base,
						'src/access_control/policy/+clerk.policy.ts': `export default { description: 'c', grants: { openings: { read: { fields: ['title'] } } },
				capabilities: { kiosks: ['desk'] } };`,
						'src/kiosk/desk/+kiosk.ts': `export default { name: 'desk', spec: { title: 'D', description: 'D', icon: 'x',
				auth: 'members', policies: ['clerk'], pages: { home: { title: 'H' } } } };`,
						'src/kiosk/desk/+home.page.svelte': `<p>hi</p>`
					})
				);
				expect(
					good.errors.filter((e) => e.code.startsWith('kiosk') || e.code === 'access/kiosk-grant')
				).toEqual([]);
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('evaluates declarations with the guest globals (rule 6)', () =>
		Effect.gen(function* () {
			const r = yield* check(
				workspace({
					'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
					'src/+secrets.ts': `const n = new TextEncoder().encode(new URL('https://a.test/x').href).length;
const f = fileRef({ id: '1', name: 'a.txt', mime: 'text/plain' });
export default structuredClone({ GLOBAL_N: { label: String(n + new TextDecoder().decode(new Uint8Array([1])).length + typeof queueMicrotask.length) }, FILE_ID: { label: f.id } });`
				})
			);
			expect(r.errors).toEqual([]);
			expect(r.manifest?.workspace.secrets?.['GLOBAL_N']?.label).toBe('17number');
			expect(r.manifest?.workspace.secrets?.['FILE_ID']?.label).toBe('1');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'bundles a `?bytes` import as a server asset by sha256, readable while declarations evaluate (§5.8, L-COL-099)',
		() =>
			Effect.gen(function* () {
				const r = yield* check(
					workspace({
						'lib/blob.bin': 'bytes\u0000!',
						'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
						'src/+secrets.ts': `import blob from '../lib/blob.bin?bytes';
export default { BYTE_COUNT: { label: String(blob.length) } };`
					})
				);
				expect(r.errors).toEqual([]);
				expect(r.manifest?.workspace.secrets?.['BYTE_COUNT']?.label).toBe('7');
				const sha = createHash('sha256').update('bytes\u0000!').digest('hex');
				expect(Object.keys(r.guest!.assets ?? {})).toEqual([sha]);
				expect(Buffer.from(r.guest!.assets![sha]!).toString()).toBe('bytes\u0000!');
				expect(r.guest!.source).toContain(sha);
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('writes the generated tsconfig before bundling, so a fresh checkout checks', () =>
		Effect.gen(function* () {
			const root = workspace({
				'tsconfig.json': JSON.stringify({ extends: './.norbital/tsconfig.json' }),
				'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`
			});
			const result = yield* check(root);
			expect(result.errors).toEqual([]);
			if (result.guest?.sourceMap === undefined)
				return yield* Effect.die(new Error('the metadata-only runtime has no source map'));
			expect(new TraceMap(result.guest.sourceMap).version).toBe(3);
			expect(existsSync(join(root, '.norbital/bolt.d.ts'))).toBe(true);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('refuses module evaluation over 100 ms of CPU (rule 6)', () =>
		Effect.gen(function* () {
			const r = yield* check(
				workspace({
					'src/+workspace.ts': `let x = 0; for (let i = 0; i < 1e9; i++) x ^= i; export default { tz: 'UTC', locale: 'en', x: x & 0 };`
				})
			);
			expect(r.errors.map((e) => e.code)).toContain('guest/eval-cpu');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('checks from the published build, where bolt is index.js', () =>
		Effect.gen(function* () {
			const built = (yield* Effect.tryPromise({
				try: () => import(new URL('../build/compiler/check/index.js', import.meta.url).href),
				catch: (cause) => new TestFailure({ cause })
			})) as {
				check: typeof check;
			};
			expect(
				(yield* built.check(workspace(GOOD))).errors.filter((e) => e.code === 'bundle/failed')
			).toEqual([]);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'refuses a label naming an id or a foreign key, and an instant named as a calendar day (model/label, model/instant-date)',
		() =>
			Effect.gen(function* () {
				const m: EngineManifest = {
					...emptyManifest,
					workspace: emptyManifest.workspace,
					models: {
						lines: {
							description: 'lines',
							label: ['order', 'title'],
							fields: {
								title: { kind: 'text' },
								shipped_on: { kind: 'instant' },
								due_date: { kind: 'instant' },
								paid_at: { kind: 'instant' },
								born_on: { kind: 'date' }
							}
						},
						orders: { description: 'orders', label: 'id', fields: {} },
						notes: {
							description: 'notes',
							label: 'code',
							fields: {},
							computed: { code: { kind: 'text', expr: { field: 'id' } } }
						}
					},
					relationships: { 'lines.order': { to: 'orders' } },
					automations: {},
					apps: {},
					policies: {},
					collections: {},
					integrations: {}
				};
				const found = checkRules(m, { automations: [] }, (_r, n) => n).map(
					(f) => `${f.code} ${f.message}`
				);
				expect(found).toEqual([
					"model/instant-date lines: shipped_on: a field named *_on or *_date is a calendar day; declare it { kind: 'date' }",
					"model/instant-date lines: due_date: a field named *_on or *_date is a calendar day; declare it { kind: 'date' }",
					expect.stringContaining("model/label lines: label 'order' is a foreign key"),
					expect.stringContaining("model/label orders: label 'id' is the row id")
				]);
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live("parses a pulled feed's cron at build (integration/cron)", () =>
		Effect.gen(function* () {
			const feed = (cron?: string) => ({
				into: 'entries',
				key: ['code'],
				...(cron === undefined ? {} : { cron })
			});
			const m: EngineManifest = {
				...emptyManifest,
				workspace: emptyManifest.workspace,
				models: {},
				relationships: {},
				automations: {},
				apps: {},
				policies: {},
				collections: {},
				integrations: {
					books: {
						description: 'x',
						driver: 'sqlserver',
						feeds: {
							good: feed('*/15 * * * *'),
							bad: feed('61 * * * *'),
							none: feed(),
							pushed: { into: 'entries', key: ['code'], from: 'messages' }
						}
					}
				}
			};
			expect(checkRules(m, { automations: [] }, (_r, n) => n).map((f) => f.message)).toEqual([
				"books: feed 'bad': cron '61 * * * *' is not 5 cron fields or a macro",
				"books: feed 'none': cron 'undefined' is not 5 cron fields or a macro"
			]);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'an outbound when tests the written row alone: its own fields and literals, no relation or operand (integration/outbound-when)',
		() =>
			Effect.gen(function* () {
				const rule = (when: object) => ({ from: 'orders', via: 'ledger', when });
				const m: EngineManifest = {
					...emptyManifest,
					workspace: emptyManifest.workspace,
					automations: {},
					apps: {},
					policies: {},
					collections: {},
					models: {
						customers: {
							description: 'customers',
							label: 'name',
							fields: { name: { kind: 'text' } }
						},
						orders: {
							description: 'orders',
							label: 'status',
							fields: { status: { kind: 'text' }, total: { kind: 'int' }, paid: { kind: 'int' } }
						},
						lines: { description: 'lines', label: 'qty', fields: { qty: { kind: 'int' } } }
					},
					relationships: {
						'orders.customer': { to: 'customers' },
						'lines.order': { to: 'orders', inverse: 'lines' }
					},
					integrations: {
						books: {
							description: 'x',
							driver: 'http',
							outbound: {
								own: rule({
									status: { in: ['confirmed', 'shipped'] },
									or: [{ total: { gt: { field: 'paid' } } }, { not: { paid: { eq: 0 } } }]
								}),
								customer: rule({ customer: { is: { name: { eq: 'Acme' } } } }),
								lines: rule({ lines: { some: { qty: { gt: 0 } } } }),
								param: rule({ status: { eq: { param: 'wanted' } } })
							}
						}
					}
				};
				expect(
					checkRules(m, { automations: [] }, (_r, n) => n).map((f) => `${f.code} ${f.message}`)
				).toEqual([
					"integration/outbound-when books: outbound 'customer': its when tests the written row of 'orders' alone: a same-row where cannot reach the relation 'customer'",
					"integration/outbound-when books: outbound 'lines': its when tests the written row of 'orders' alone: a same-row where cannot reach the relation 'lines'",
					"integration/outbound-when books: outbound 'param': its when tests the written row of 'orders' alone: a same-row where takes literals and the row's own fields only"
				]);
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('parses cron strings at build (rule 52)', () =>
		Effect.gen(function* () {
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
		}).pipe(Effect.provide(NodeServices.layer))
	);
});
class TestFailure extends Schema.TaggedError<TestFailure>()('TestFailure', {
	cause: Schema.Defect()
}) {}

it.live('refuses a non-generator in a ctx-bearing slot even when attach is bypassed', () =>
	Effect.gen(function* () {
		const root = workspace({
			'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
			'src/data/model/+orders.model.ts': `export default { description: 'Orders', label: 'title', fields: { title: { kind: 'text' } } };`,
			'src/data/collection/orders/+collection.ts': `export default { name: 'orders', spec: { read: { fields: 'all' } }, bodies: { transform: async rows => rows, queries: {}, actions: {} } };`
		});
		expect((yield* check(root)).errors).toContainEqual({
			code: 'guest/body-generator',
			path: 'src',
			message: 'a ctx-bearing body must be a generator function'
		});
	}).pipe(Effect.provide(NodeServices.layer))
);
