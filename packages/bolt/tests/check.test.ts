import { Effect, Schema } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
/// <reference types="node" />
// `bolt check` (rule 7): stage order, every error in one run, isolate evaluation (rule 2), guest walls (rule 6), the names
// index `bolt sync` prints, and the build checks of §3.3.9 (model/range, model/seq, automation/cron, automation/event-input,
// model/label, model/instant-date, access/ip-limit, access/limit, access/visitor-grant, access/visitor-ref,
// access/masked-search, sync/*, kiosk/embed, app/embed,
// write/read-in-loop, notify/via).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import ivm from 'isolated-vm';
import { PRELUDE } from '../src/engine/guest/prelude.ts';
import { assetHook, digest, randomStream } from '../src/node/guest-isolates.ts';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { check, sync } from '../src/compiler/check/index.ts';
import { checkRules, cronValid, sourceRules } from '../src/compiler/check/rules.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
const emptyManifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
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
/** A raw model declaration for metadata-loading probes independent of the public factory. */
const plain = (name: string, literal: string) =>
	`export default { name: ${JSON.stringify(name)}, spec: ${literal} };`;
const GOOD = {
	'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
	'src/data/model/orders/+model.ts': `import { model } from '@norbital-ai/bolt';
export default model('orders', { description: 'Orders', label: 'title', fields: { title: { kind: 'text' },
	stamp: { kind: 'text', default: new Date().toISOString() }, luck: { kind: 'int', default: Math.floor(Math.random() * 1e9) } },
	read: { orders: { fields: 'all' } },
	create: { columns: { orders: ['title'] }, transform: function* (rows) { return rows; } },
 notify: function* () { return []; } });`,
	'src/access_control/policy/+rep.policy.ts': `export default { description: 'Rep', grants: { orders: { read: true,
	create: { check: function* (rows, ctx) { return rows.length > 0 ? ctx.allow() : ctx.deny('Nothing to create.'); } } } } };`,
	'src/automation/+nightly.automation.ts': `import { automation } from '@norbital-ai/bolt';
export default automation('nightly', { description: 'Nightly', on: { cron: '0 2 * * 1-5' }, runAs: ['rep'], run: function* () {} });`,
	'seed/orders.json': JSON.stringify([
		{ id: '0199a000-0000-4000-8000-000000000001', title: 'seeded' }
	])
};
describe('bolt check', () => {
	it.live(
		'runs discover → bundle → evaluate → manifest → names → seed → schema → rules and compiles a clean workspace',
		() =>
			Effect.gen(function* () {
				const root = workspace(GOOD);
				const r = yield* check(root);
				expect(r.errors).toEqual([]);
				expect(r.stages).toEqual([
					'discover',
					'bundle',
					'evaluate',
					'manifest',
					'names',
					'seed',
					'schema',
					'rules'
				]);
				expect(r.transforms).toEqual(['orders.create']);
				expect(r.manifest!.exposures['orders']).toMatchObject({
					read: { orders: { fields: 'all' } },
					create: { columns: { orders: ['title'] }, transform: true },
					notify: true
				});
				expect(r.manifest!.exposures['orders']).not.toHaveProperty('queries');
				// a policy's write check is marked in the manifest; its body runs in the guest
				expect(r.manifest!.policies['rep']!.grants['orders']).toMatchObject({
					create: { check: true }
				});
				expect(r.manifest!.models['orders']!.fields['stamp']).toMatchObject({
					default: '2000-01-01T00:00:00.000Z'
				});
				expect(r.manifest!.automations['nightly']).toMatchObject({ runAs: ['rep'] });
				expect(r.seed).toEqual({
					orders: [{ id: '0199a000-0000-4000-8000-000000000001', title: 'seeded' }]
				});
				expect(r.guest!.source).toContain('bodies');
				// the names index is literal data, never a type read from a source file (no body can type itself)
				const names = readFileSync(join(root, '.norbital/names.ts'), 'utf8');
				expect(names).not.toContain('typeof import');
				expect(names).toContain('"label": "title";');
				expect(names).toContain('"orders": readonly ["title"];');
				expect(names).toContain('"transform": true;');
				expect(names).toContain('"nightly": { spec: {');
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'bolt sync writes the names index from the evaluated declarations, and a failed evaluation keeps the last good one',
		() =>
			Effect.gen(function* () {
				const root = workspace(GOOD);
				const synced = yield* sync(root);
				expect(synced.errors).toEqual([]);
				expect(synced.stages).toEqual(['discover', 'bundle', 'evaluate', 'manifest', 'names']);
				const file = join(root, '.norbital/names.ts');
				const good = readFileSync(file, 'utf8');
				expect(good).toContain('"orders": {');
				writeFileSync(
					join(root, 'src/data/model/orders/+model.ts'),
					`throw new Error('half-saved'); export default 1;`
				);
				const broken = yield* sync(root);
				expect(broken.errors.map((e) => e.code)).toContain('load/failed');
				expect(readFileSync(file, 'utf8')).toBe(good);
				// a literal that is no model literal fails the names stage alone, keeping the index as well
				writeFileSync(
					join(root, 'src/data/model/orders/+model.ts'),
					plain('orders', `{ label: 'x' }`)
				);
				const odd = yield* sync(root);
				expect(odd.errors.map((e) => e.code)).toContain('names/failed');
				expect(readFileSync(file, 'utf8')).toBe(good);
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live("refuses a declaration whose name is not its path's (load/name-path)", () =>
		Effect.gen(function* () {
			const r = yield* check(
				workspace({
					...GOOD,
					'src/data/model/orders/+model.ts': plain(
						'order',
						`{ description: 'o', label: 'title', fields: { title: { kind: 'text' } }, read: 'all' }`
					),
					'src/automation/+nightly.automation.ts': `export default { name: 'daily', spec: { description: 'n' }, body: undefined };`
				})
			);
			expect(
				r.errors
					.filter((e) => e.code === 'load/name-path')
					.map(({ path, message }) => ({ path, message }))
			).toEqual([
				{
					path: 'src/data/model/orders/+model.ts',
					message:
						"src/data/model/orders/+model.ts: declares model('order'); its path names it 'orders'"
				},
				{
					path: 'src/automation/+nightly.automation.ts',
					message:
						"src/automation/+nightly.automation.ts: declares automation('daily'); its path names it 'nightly'"
				}
			]);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'validates full declaration metadata before omitting unused data from the runtime guest',
		() =>
			Effect.gen(function* () {
				const literal = `{ description: 'compile_only_model_marker', label: 'title', fields: { title: { kind: 'text' } }, read: 'all', create: { columns: { orders: ['title'] } } }`;
				const argumentLiteral = literal.replace(
					"description: 'compile_only_model_marker'",
					"description: (globalThis.bodyFreeModelArgumentInitialized = true, 'compile_only_model_marker')"
				);
				for (const declaration of [
					plain('orders', literal),
					`import { model } from '@norbital-ai/bolt'; export default model('orders', ${argumentLiteral});`
				]) {
					const files = {
						...GOOD,
						'src/data/model/orders/+model.ts': `globalThis.bodyFreeModelInitialized = true;\n${declaration}`,
						'src/i18n/+messages.ts': `export default { 'orders.title': 'compile_only_base_message_marker' };`,
						'src/i18n/+zh.messages.ts': `export default { 'orders.title': 'compile_only_locale_marker' };`
					};
					const result = yield* check(workspace(files));
					expect(result.errors).toEqual([]);
					expect(result.manifest?.models['orders']?.description).toBe('compile_only_model_marker');
					// a body-free model and the messages are data only: the runtime guest keeps none of it
					for (const marker of [
						'compile_only_model_marker',
						'compile_only_base_message_marker',
						'compile_only_locale_marker'
					])
						expect(result.guest?.source).not.toContain(marker);
					expect(result.guest?.source).toContain('bodyFreeModelInitialized');
					if (declaration.includes('bodyFreeModelArgumentInitialized'))
						expect(result.guest?.source).toContain('bodyFreeModelArgumentInitialized');
					const invalid = yield* check(
						workspace({
							...files,
							'src/data/model/orders/+model.ts': files['src/data/model/orders/+model.ts'].replace(
								"label: 'title'",
								"label: 'id'"
							)
						})
					);
					expect(invalid.errors.some((error) => error.code === 'model/label')).toBe(true);
					expect(invalid.guest?.source).toContain('compile_only_model_marker');
					expect(invalid.guest?.source).toContain('compile_only_locale_marker');
				}
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'minifies guest bindings while preserving declarations, callable names, assets and original source positions',
		() =>
			Effect.gen(function* () {
				const files = {
					...GOOD,
					'src/+workspace.ts': `globalThis.roleInitialization = ['workspace'];\n${GOOD['src/+workspace.ts']}`,
					'src/i18n/+messages.ts': `globalThis.roleInitialization.push('messages'); export default { 'orders.title': 'Orders' };`,
					'src/i18n/+zh.messages.ts': `globalThis.roleInitialization.push('locale'); export default { 'orders.title': '订单' };`,
					'lib/blob.bin': 'bytes\u0000!',
					'src/access_control/policy/+rep.policy.ts': `export default { description: 'Rep', grants: { orders: { read: true,
	create: { check: function* checkOrders(rows, ctx) { return ctx.allow(); } } } } };`,
					'src/data/model/orders/+model.ts': `globalThis.roleInitialization.push('model');
import { model } from '@norbital-ai/bolt';
import blob from '../../../../lib/blob.bin?bytes';
class OrderMarker {}
function* transformOrders(rows) { return rows.map((row) => ({ ...row, size: blob.length })); }
export default model('orders', { description: OrderMarker.name, label: 'title', fields: { title: { kind: 'text' }, size: { kind: 'int', optional: true } },
	read: { orders: { fields: 'all' } }, create: { columns: { orders: ['title'] }, transform: transformOrders } });`
				};
				const root = workspace(files);
				const result = yield* check(root);
				expect(result.errors).toEqual([]);
				expect(result.manifest).toEqual((yield* check(root)).manifest);
				expect(result.manifest!.models['orders']!.description).toBe('OrderMarker');
				const map = new TraceMap(JSON.parse(result.guest!.sourceMap!));
				const source = result.guest!.source;
				const at = /function\s*\*\s*transformOrders\b/.exec(source)?.index ?? -1;
				expect(at).toBeGreaterThan(-1);
				const prefix = source.slice(0, at);
				const position = originalPositionFor(map, {
					line: prefix.split('\n').length,
					column: prefix.length - prefix.lastIndexOf('\n') - 1
				});
				expect(position.source).toContain('src/data/model/orders/+model.ts');
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
									`(async()=>{ const c=__ns.default.model.orders, check=__ns.default.policy.rep.grants.orders.create.check; return { transformName:c.bodies.create.name, rows:await c.bodies.create([{title:'kept'}]), checkName:check.name, checkKind:typeof check, initialized:globalThis.roleInitialization, roles:Object.keys(__ns.default).sort() }; })()`,
									{ promise: true, copy: true }
								),
							catch: (cause) => new TestFailure({ cause })
						})
					).toEqual({
						transformName: 'transformOrders',
						rows: [{ title: 'kept', size: 7 }],
						checkName: 'checkOrders',
						checkKind: 'function',
						initialized: ['workspace', 'model', 'messages', 'locale'],
						roles: ['automation', 'model', 'policy']
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
function* dynamicBody() {
 const before = globalThis.dynamicInitializations ?? 0;
 const first = yield* Effect.tryPromise({ try: () => import('../lib/dynamic.ts'), catch: () => new Refusal({ message: 'dynamic import failed' }) });
 first.increment();
 const second = yield* Effect.tryPromise({ try: () => import('../lib/dynamic.ts'), catch: () => new Refusal({ message: 'dynamic import failed' }) });
 return { before, after: globalThis.dynamicInitializations, same: first === second, first: first.value, second: second.value };
}
export default automation('a', { description: 'Dynamic', on: { cron: '0 0 * * *' }, run: dynamicBody });`
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
					'src/data/model/orders/+model.ts': `import { read } from '../../../lib/disk.ts'; void read;
${plain(
	'orders',
	`{ description: 'o', label: 'title', search: { text: ['title'], semantic: { fields: ['title'], model: 'default', dim: 5000 } }, fields: { title: { kind: 'text' },
	v: { kind: 'vector', dim: 5000, metric: 'l2' }, n: { kind: 'seq', pattern: 'X-{abc}' },
	s: { kind: 'state', initial: 'nope', states: { a: {} } }, at: { kind: 'time', precision: 'month' } },
	read: { orders: { fields: 'all' } }, create: { columns: { orders: ['title'] } } }`
)}`,
					'src/data/model/openings/+model.ts': plain(
						'openings',
						`{ description: 'o', label: 'title', fields: { title: { kind: 'text' } }, read: { openings: { fields: 'all' } } }`
					),
					'src/data/model/sources/+model.ts': plain(
						'sources',
						`{ description: 's', label: 'name', fields: { name: { kind: 'text' } }, read: { sources: { fields: 'all' } } }`
					),
					'src/data/model/applications/+model.ts': plain(
						'applications',
						`{ description: 'a', label: 'name', fields: { name: { kind: 'text' },
	opening: { kind: 'ref', to: 'openings', inverse: 'applications' }, source: { kind: 'ref', to: 'sources' } },
	read: { applications: { fields: 'all' } }, create: { columns: { applications: ['name', 'opening', 'source'] } },
	update: { columns: { applications: ['name'] } } }`
					),
					'src/access_control/team/+team.ts': `export default { a: [] };`,
					'src/access_control/policy/+rep.policy.ts': `export default { description: 'r', grants: { orders: { read: true } },
	limits: { act: { rate: '5/min', per: 'ip' }, read: '0/min' } };`,
					'src/access_control/policy/+auditor.policy.ts': `export default { description: 'a', grants: { orders: { read: { orders: { fields: ['v'] } } } } };`,
					'src/access_control/policy/+applicant.policy.ts': `export default { description: 'v', grants: { applications: { create: true, update: true } } };`,
					'src/access_control/policy/+kiosk.policy.ts': `export default { description: 'k', grants: { openings: { read: true } } };`,
					'src/app/careers/+app.ts': `export default { name: 'careers', spec: { title: 'c', description: 'c', icon: 'x', audience: { public: ['applicant', 'kiosk'] }, pages: {} } };`,
					'src/automation/+tick.automation.ts': `export default { name: 'tick', spec: { description: 't', on: [{ cron: '61 * * * *' }, { created: 'orders' }],
	input: { note: { kind: 'text' } }, runAs: ['rep'] } };`
				})
			);
			const codes = [...new Set(r.errors.map((e) => e.code))].sort();
			expect(codes).toEqual([
				'access/ip-limit',
				'access/limit',
				'access/masked-search',
				'access/visitor-grant',
				'access/visitor-ref',
				'automation/cron',
				'automation/event-input',
				'automation/no-body',
				'discover/unknown-role',
				'guest/node-import',
				'model/precision',
				'model/range',
				'model/seq',
				'model/state',
				'schema/schema'
			]);
			expect(r.errors.find((e) => e.code === 'schema/schema')).toMatchObject({
				path: 'src/data',
				message: expect.stringContaining('precision')
			});
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
					'src/data/model/openings/+model.ts': plain(
						'openings',
						`{ description: 'o', label: 'title', fields: { title: { kind: 'text' } }, read: { openings: { fields: 'all' } },
				create: { columns: { openings: ['title'] } }, update: { columns: { openings: ['title'] } } }`
					),
					'src/access_control/policy/+lobby.policy.ts': `export default { description: 'l', grants: { openings: {
				read: { openings: { where: {}, fields: ['id', 'title'] } }, update: { columns: { openings: ['title'] } } } } };`
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
						'src/access_control/policy/+clerk.policy.ts': `export default { description: 'c', grants: { openings: { read: { openings: { fields: ['title'] } } } },
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
					exposures: {},
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
	it('checks a custom search index: its width, its rerank page, its name and its vector field (model/range)', () => {
		const index = { description: 'x', input: {}, metric: 'l2' as const };
		const m: EngineManifest = {
			...emptyManifest,
			models: {
				trials: {
					description: 'trials',
					label: 'name',
					fields: { name: { kind: 'text' }, lab: { kind: 'vector', dim: 3, metric: 'l2' } },
					search: {
						text: ['name'],
						indexes: {
							colour: { ...index, dim: 3, candidates: 4 },
							stored: { ...index, dim: 3, field: 'lab' },
							wide: { ...index, dim: 2001 },
							semantic: { ...index, dim: 3 },
							mismatched: { ...index, dim: 4, field: 'lab' },
							paged: { ...index, dim: 3, candidates: 1 }
						}
					}
				}
			}
		};
		expect(checkRules(m, { automations: [] }, (_r, n) => n).map((f) => f.message)).toEqual([
			'trials: search.indexes.wide: dim is 1 to 2,000',
			"trials: search.indexes.semantic: 'semantic' is the platform's meaning search; name the index",
			"trials: search.indexes.mismatched: vector 'lab' is a vector field of dim 4"
		]);
	});
	it.live('refuses a polymorphic ref nested in an inline value; a single-target one stands (model/inline-ref)', () =>
		Effect.gen(function* () {
			const arc = `{ kind: 'ref', to: ['a', 'b'] }`;
			const r = yield* check(
				workspace({
					'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
					'src/data/model/trials/+model.ts': plain(
						'trials',
						`{ description: 't', label: 'name', fields: { name: { kind: 'text' },
	owner: { kind: 'json', shape: { kind: 'object', fields: { at: { kind: 'ref', to: 'trials' } } } },
	links: { kind: 'list', of: ${arc} },
	meta: { kind: 'json', shape: { kind: 'object', fields: { about: ${arc} } } } } }`
					)
				})
			);
			// tsc refuses this literal; a plain module reaches the rule
			expect(r.errors.map((e) => `${e.code} ${e.message.split(': ')[1]}`)).toEqual([
				'model/inline-ref links',
				'model/inline-ref meta'
			]);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it("checks a sync: its connection, a file's parsers, a remote's cadence and partitions, and a write's one instance (sync/*)", () => {
		const m: EngineManifest = {
			...emptyManifest,
			models: {
				customers: { description: 'c', label: 'name', fields: { name: { kind: 'text' } } },
				events: { description: 'e', label: 'title', fields: { title: { kind: 'text' } } }
			},
			relationships: {
				'events.calendar': {
					to: 'sys_integration',
					where: { integration: { eq: 'calendar' } }
				}
			},
			integrations: {
				crm: { description: 'CRM', driver: 'http' },
				calendar: {
					description: 'Calendars',
					driver: 'calendar',
					configuration: { calendars: { kind: 'list', of: { kind: 'text' } } }
				}
			},
			connections: {
				crm_a: { integration: 'crm' },
				crm_b: { integration: 'crm' }
			},
			exposures: {
				customers: {
					read: { customers: { fields: 'all' } },
					syncs: {
						sheet: { with: 'file', parser: ['xlsx', 'csv'] },
						ofx: {
							with: 'file',
							parser: ['numbers', { type: 'application/vnd.intu.qfx', extensions: ['ofx'] }],
							every: '1h'
						},
						crm: { with: 'crm', every: 'often', read: true, write: true },
						mirror: { with: 'crm', read: true },
						erp: { with: 'erp', read: true }
					}
				},
				events: {
					read: { events: { fields: 'all' } },
					syncs: {
						calendar: { with: 'calendar', partitions: 'calendars', read: true, write: true },
						typo: { with: 'calendar', partitions: 'calendar', read: true }
					}
				}
			}
		};
		expect(
			checkRules(m, { automations: [] }, (_r, n) => n).map((f) => `${f.code} ${f.message}`)
		).toEqual([
			"sync/file customers: syncs.ofx: a file sync runs on upload and export; every and partitions are a remote sync's",
			"sync/parser customers: syncs.ofx: 'numbers' is no built-in parser (xlsx, csv, tsv, json, ics)",
			"sync/parser customers: syncs.ofx: a custom parser lists its file extensions ('.ofx')",
			"sync/every customers: syncs.crm: 'often' is not a duration ('15min', '1h')",
			expect.stringContaining(
				"sync/instance customers: syncs.crm: a write goes through one instance of 'crm'"
			),
			"sync/with customers: syncs.erp: with 'erp' is 'file' or an integration definition",
			"sync/partitions events: syncs.typo: 'calendar' is no configuration field of 'calendar'"
		]);
	});
	it('an embedding origin is https://host[:port], and only a kiosk or a portal page is embedded (kiosk/embed, app/embed)', () => {
		const page = { title: 'P' };
		const m: EngineManifest = {
			...emptyManifest,
			policies: { lobby: { description: 'l', grants: {} } },
			kiosks: {
				lobby: {
					title: 'L',
					description: 'L',
					icon: 'x',
					auth: 'members',
					policies: ['lobby'],
					pages: { home: page },
					embed: ['https://partner.example', 'https://partner.example:8443/path', 'https://a b']
				}
			},
			apps: {
				shop: {
					title: 'S',
					description: 'S',
					icon: 'x',
					pages: {
						home: { ...page, portal: true, embed: ['https://*.example'] },
						open: { ...page, portal: true, embed: ['https://partner.example'] }
					}
				}
			}
		};
		expect(
			checkRules(m, { automations: [] }, (_r, n) => n).map((f) => `${f.code} ${f.message}`)
		).toEqual([
			"kiosk/embed lobby: embed: 'https://partner.example:8443/path' is an origin, https://host[:port] (no path, no wildcard)",
			"kiosk/embed lobby: embed: 'https://a b' is an origin, https://host[:port] (no path, no wildcard)",
			"app/embed shop: embed: 'https://*.example' is an origin, https://host[:port] (no path, no wildcard)"
		]);
	});
	it('reads the model sources: a write callback reading inside a loop, a notice through a non-conversation connection (write/read-in-loop, notify/via)', () => {
		const m: EngineManifest = {
			...emptyManifest,
			integrations: { crm: { description: 'CRM', driver: 'http' } },
			connections: { support: { integration: 'whatsapp' }, books: { integration: 'crm' } }
		};
		const text = `import { model } from '@norbital-ai/bolt';
export default model('orders', {
	description: 'o', label: 'title', fields: { title: { kind: 'text' } }, read: 'all',
	create: {
		columns: { orders: ['title'] },
		transform: function* (rows, ctx) {
			const known = yield* ctx.db.query({ orders: { where: { title: { in: rows.map((r) => r.title) } } } });
			for (const row of rows) yield* ctx.db.query({ orders: { where: { title: { eq: row.title } }, limit: 1 } });
			return rows;
		}
	},
	update: {
		columns: { orders: ['title'] },
		*transform(changes, ctx) {
			yield* Effect.all(changes.map(function* (c) { return yield* ctx.db.after('orders', { id: { eq: c.before.id } }); }));
			return changes.map((c) => c.set);
		}
	},
	notify: function* (event, ctx) { for (const x of [1, 2]) yield* ctx.db.query({ orders: { limit: 1 } });
		return [{ title: 'New', to: [{ team: 'sales' }], via: ['support', 'books', 'nowhere'] }];
	}
});`;
		const found = sourceRules(m, [{ path: 'src/data/model/orders/+model.ts', text }]);
		expect(found.map((f) => `${f.code} ${f.line}`)).toEqual([
			'write/read-in-loop 8',
			'write/read-in-loop 15',
			'notify/via 20',
			'notify/via 20'
		]);
		expect(found[0]!.message).toContain('a write callback reads inside a loop over its rows');
		expect(found[2]!.message).toContain("'books' is not one");
		expect(found[3]!.message).toContain("'nowhere' is not one");
	});
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
			'src/data/model/orders/+model.ts': `export default { name: 'orders', spec: { description: 'Orders', label: 'title', fields: { title: { kind: 'text' } }, read: { orders: { fields: 'all' } } },
	bodies: { create: async rows => rows, indexes: {}, syncs: {} } };`
		});
		expect((yield* check(root)).errors).toContainEqual({
			code: 'guest/body-generator',
			path: 'src',
			message: 'a ctx-bearing body must be a generator function'
		});
	}).pipe(Effect.provide(NodeServices.layer))
);
