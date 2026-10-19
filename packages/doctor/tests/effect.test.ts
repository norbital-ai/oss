import { it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect } from 'vitest';
import { doctor } from '../src/index.js';

// The first type-aware program loads TypeScript's lib files once per worker; pay that here, not in whichever test runs first.
beforeAll(() => {
	const root = mkdtempSync(join(tmpdir(), 'doctor-warm-'));
	writeFileSync(join(root, 'warm.ts'), 'export const value = 1;');
	doctor({ root, files: ['warm.ts'], packs: ['realm/effect'] });
	rmSync(root, { recursive: true });
});

it.live('scopes native control by path even when Effect is not imported', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-effect-scope-' });
		yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '[]');
		yield* fs.writeFileString(
			path.join(root, 'owned.ts'),
			'export async function read() { return 1; }'
		);
		expect(
			doctor({ root, files: ['owned.ts'], packs: ['realm/effect'] }).filter(
				(finding) => finding.rule === 'EFF3'
			)
		).toHaveLength(0);
		yield* fs.writeFileString(
			path.join(root, '.norbital-doctor-effect-scope.json'),
			'["owned.ts"]'
		);
		expect(
			doctor({ root, files: ['owned.ts'], packs: ['realm/effect'] }).filter(
				(finding) => finding.rule === 'EFF3'
			)
		).toHaveLength(1);
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('runtime creation is reported in owned modules and permitted only at entry edges', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-effect-edges-' });
		yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
		const files = ['src/owned.ts', 'packages/bolt/src/cli/main.ts', 'private/main.ts'];
		const source = `
export const run = () => Effect.runPromiseExit(work);
export const runtime = ManagedRuntime.make(layer);
export const context = Context.makeUnsafe(services);
`;
		for (const file of files) {
			yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
			yield* fs.writeFileString(path.join(root, file), source);
		}
		const counts = () => {
			const found = doctor({ root, files, packs: ['realm/effect'] }).filter(
				(finding) => finding.rule === 'EFF8'
			);
			return files.map(
				(file) => found.filter((finding) => finding.location.startsWith(`${file}:`)).length
			);
		};
		expect(counts()).toEqual([3, 0, 3]);
		yield* fs.writeFileString(
			path.join(root, '.norbital-doctor-effect-edges.json'),
			'["private/main.ts"]'
		);
		expect(counts()).toEqual([3, 0, 0]);
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('skill fences report only registered tenant async bodies at their Markdown lines', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem,
			path = yield* Path.Path;
		const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-skill-bodies-' });
		const file = '.agents/skills/example/SKILL.md';
		yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
		yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '[]');
		const badTs = 'task.run(async (payload, services) => services.read("notes"));';
		const badJs = 'bolt.automation({ description: "job" }).run(async () => 1);';
		const badSvelte = 'job.run(async (value, api) => api.read("notes"));';
		const lines = [
			'# Tenant bodies',
			'Prose mentioning a.run(async (input, ctx) => ctx.read("notes")) is not code.',
			'```ts',
			'import { automation as defineJob } from "@norbital-ai/bolt";',
			'const first = defineJob({ description: "job" });',
			'const task = first;',
			badTs,
			'```',
			'```javascript',
			'import * as bolt from "@norbital-ai/bolt";',
			badJs,
			'```',
			'~~~svelte',
			'<script lang="ts">',
			'import { automation } from "@norbital-ai/bolt";',
			'const job = automation({ description: "job" });',
			badSvelte,
			'</script>',
			'<button>Presentation</button>',
			'~~~',
			'```ts',
			'import { Effect } from "effect";',
			'export const nativeEdge = async (input, ctx) => Effect.runPromise(input, { signal: ctx.signal });',
			'const example = \'a.run(async (input, ctx) => ctx.read("notes"))\';',
			'const presentation = { run: (callback) => callback() };',
			'presentation.run(async (input, ctx) => ctx.read("notes"));',
			'```',
			'```svelte',
			'<script>',
			'const onClick = async () => fetch("/presentation");',
			'</script>',
			'<button onclick={onClick}>Read</button>',
			'```',
			'```ts',
			'import { automation } from "@norbital-ai/bolt";',
			'function shadowed(automation) {',
			'  const task = automation({ description: "presentation" });',
			'  task.run(async (input, ctx) => ctx.read("notes"));',
			'}',
			'const isolated = automation({ description: "job" });',
			'```',
			'```ts',
			'isolated.run(async (input, ctx) => ctx.read("notes"));',
			'```',
			'````markdown',
			'```ts',
			'import { automation } from "@norbital-ai/bolt";',
			'automation({ description: "quoted example" }).run(async () => 1);',
			'```',
			'````'
		];
		const source = lines.join('\n');
		yield* fs.writeFileString(path.join(root, file), source);
		const findings = () => doctor({ root, files: [file], packs: ['realm/effect'] });
		expect(
			findings()
				.map((finding) => ({ rule: finding.rule, location: finding.location }))
				.sort((left, right) => left.location.localeCompare(right.location))
		).toEqual(
			[badTs, badJs, badSvelte]
				.map((body) => ({
					rule: 'EFF3',
					location: `${file}:${lines.indexOf(body) + 1}: ${body} [matched]`
				}))
				.sort((left, right) => left.location.localeCompare(right.location))
		);
		yield* fs.writeFileString(
			path.join(root, file),
			source
				.replace(
					badTs,
					'task.run(function* (payload, services) { return yield* services.read("notes"); });'
				)
				.replace(badJs, 'bolt.automation({ description: "job" }).run(function* () { return 1; });')
				.replace(badSvelte, 'job.run(function* (value, api) { return yield* api.read("notes"); });')
		);
		expect(findings()).toEqual([]);
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'finds floating Effects, inferred unknown failures and an unbatched ctx call by resolved types',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-effect-types-' });
			yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
			yield* fs.writeFileString(
				path.join(root, 'owned.ts'),
				`
interface Effect<A, E, R = never> { readonly effect: A; readonly error: E; readonly requires: R }
declare namespace Effect {
 function succeed<A>(value: A): Effect<A, never>;
 function all<A, E>(values: readonly Effect<A,E>[], options?: {concurrency:number}): Effect<A[],E>;
 function tryPromise<A,E>(options:{try:()=>Promise<A>;catch:(error:unknown)=>E}):Effect<A,E>;
}
declare const ctx: { read(): Effect<number, { readonly _tag: 'ReadError' }> };
Effect.succeed(1);
export const batch = Effect.all([ctx.read()]);
const helper = () => ctx.read();
export const indirect = Effect.all([helper()]);
export const erased = Effect.tryPromise({try:()=>Promise.resolve(1),catch:error=>error});
export const good = Effect.all([ctx.read()], {concurrency:2});
`
			);
			const found = doctor({ root, files: ['owned.ts'], packs: ['realm/types'] });
			expect(found.map((finding) => finding.rule)).toEqual(
				expect.arrayContaining(['EFF9', 'EFF10', 'EFF11'])
			);
			expect(found.filter((finding) => finding.location.includes('export const good'))).toEqual([]);
		}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'floating Effect findings distinguish retained values and delegated execution from discarded work',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-effect-discard-' });
			yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
			const discarded = [
				'work;',
				'Effect.succeed(1);',
				'(work);',
				'work!;',
				'work satisfies Effect<number, ReadError>;',
				'void work;',
				'holder.work;',
				'aliasWork;',
				'ready && work;',
				'ready || work;',
				'maybeReady ?? work;',
				'ready ? work : Effect.succeed(2);',
				'(stored = work, work);',
				'stored = (work, work);',
				'export function* misplaced() { yield* (work, child.unref); }'
			];
			const awaited = 'export async function awaited() { await Promise.resolve(work); }';
			const lines = [
				'interface Effect<A, E = never, R = never> { readonly value: A; readonly error: E; readonly requires: R; [Symbol.iterator](): Generator<Effect<A, E, R>, A, unknown> }',
				'type Job<E, A> = Effect<A, E>;',
				'interface ReadError { readonly _tag: "ReadError" }',
				'declare namespace Effect { function succeed<A>(value: A): Effect<A>; function cached<A, E, R>(value: Effect<A, E, R>): Effect<Effect<A, E, R>>; }',
				'declare const work: Effect<number, ReadError>;',
				'declare const aliasWork: Job<ReadError, number> & { readonly label: string };',
				'declare const child: { readonly unref: Effect<Effect<void>> };',
				'declare const holder: { work?: Effect<number, ReadError> };',
				'declare const keyed: Record<string, Effect<number, ReadError> | undefined>;',
				'declare const ready: boolean;',
				'declare const maybeReady: boolean | undefined;',
				'let stored: Effect<number, ReadError> | undefined;',
				'export function* retained(): Generator<unknown, void, unknown> {',
				'  stored = work;',
				'  (stored = work);',
				'  holder.work = work;',
				'  keyed["work"] = work;',
				'  holder.work ??= yield* Effect.cached(work);',
				'  holder.work ||= work;',
				'  holder.work &&= work;',
				'  stored = yield* Effect.cached(work);',
				'  yield* child.unref;',
				'  (yield* child.unref);',
				'  void (yield* child.unref);',
				'  ready && (stored = work);',
				'  ready || (holder.work = work);',
				'  maybeReady ?? (stored = work);',
				'  ready ? (stored = work) : (holder.work = work);',
				'  (stored = work, holder.work = work);',
				'  stored = ready ? work : Effect.succeed(2);',
				'  stored = maybeReady ? work : undefined;',
				'}',
				...discarded,
				awaited
			];
			yield* fs.writeFileString(path.join(root, 'owned.ts'), lines.join('\n'));
			const found = doctor({ root, files: ['owned.ts'], packs: ['realm/types'] }).filter(
				(finding) => finding.rule === 'EFF9'
			);
			expect(found.map((finding) => finding.location).sort()).toEqual(
				[...discarded, awaited].map((line) => `owned.ts:${lines.indexOf(line) + 1}: ${line}`).sort()
			);
		}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'guest timing and traced factories follow runtime imports from the compiler role roots',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-guest-graph-' });
			const violation = `export const pause = Effect.sleep(10);
export const traced = Effect.fn('trace')(function* () { return 1; });`;
			const files: Record<string, string> = {
				'.norbital-doctor-effect-scope.json': '["**"]',
				'tsconfig.json':
					'{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler","baseUrl":".","paths":{"#guest/*":["src/lib/*"]}}}',
				'src/automation/+sync.automation.ts': `import { pause } from '#guest/barrel.js';
import type { Token } from '../lib/type-only.js';
import { type Other } from '../lib/named-type-only.js';
import background from '../lib/background.ts?worker';
export default { body: function* () { yield* pause; } };`,
				'src/lib/barrel.ts': `export { pause } from '../../shared/flow.js';
export type { Token } from './export-type-only.js';
export { type Other } from './named-export-type-only.js';`,
				'shared/flow.ts': violation,
				'src/lib/type-only.ts': `export type Token = string; ${violation}`,
				'src/lib/named-type-only.ts': `export type Other = string; ${violation}`,
				'src/lib/export-type-only.ts': `export type Token = string; ${violation}`,
				'src/lib/named-export-type-only.ts': `export type Other = string; ${violation}`,
				'src/lib/background.ts': violation,
				'src/lib/server/billing.ts': violation,
				'src/data/collection/.draft/+collection.ts': `import '../../../lib/draft-only.js'; export default {};`,
				'src/lib/draft-only.ts': violation,
				'src/routes/+server.ts': `import '../lib/server/billing.js';`,
				'src/lib/ui.ts': violation,
				'src/lib/ui.worker.ts': violation,
				'src/app/desk/+page.svelte': `<script>import '../../lib/ui.js'; new Worker(new URL('../../lib/ui.worker.ts', import.meta.url));</script>`,
				'src/data/model/+record.model.ts': `import { pause } from '../declaration-helper.js'; export default { default: pause };`,
				'src/data/declaration-helper.ts': violation,
				'packages/bolt/package.json': '{"name":"@norbital-ai/bolt"}',
				'packages/bolt/src/index.ts': `export { pause } from './decl/declaration.js';`,
				'packages/bolt/src/decl/declaration.ts': violation,
				'packages/bolt/src/decl/runtime/guest.ts': violation
			};
			for (const [file, text] of Object.entries(files)) {
				yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
				yield* fs.writeFileString(path.join(root, file), text);
			}
			const found = doctor({
				root,
				files: Object.keys(files).filter((file) => /\.(?:ts|svelte)$/.test(file)),
				packs: ['realm/effect']
			})
				.filter((finding) => finding.rule === 'EFF15' || finding.rule === 'EFF16')
				.map((finding) => `${finding.rule}:${finding.location.split(':')[0]}`)
				.sort();
			expect(found).toEqual(
				['EFF15', 'EFF16']
					.flatMap((rule) => [
						`${rule}:shared/flow.ts`,
						`${rule}:src/data/declaration-helper.ts`,
						`${rule}:packages/bolt/src/decl/declaration.ts`,
						`${rule}:packages/bolt/src/decl/runtime/guest.ts`
					])
					.sort()
			);
		}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'a later guest analysis observes edited imports and follows helper cycles without stale reachability',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-guest-edits-' });
			for (const directory of ['src/automation', 'src/lib'])
				yield* fs.makeDirectory(path.join(root, directory), { recursive: true });
			yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
			const entry = path.join(root, 'src/automation/+sync.automation.ts');
			yield* fs.writeFileString(entry, `import '../lib/flow.js'; export default {};`);
			yield* fs.writeFileString(
				path.join(root, 'src/lib/flow.ts'),
				`import './cycle.js'; export const pause = Effect.sleep(10);`
			);
			yield* fs.writeFileString(path.join(root, 'src/lib/cycle.ts'), `export * from './flow.js';`);
			const findings = () =>
				doctor({ root, files: ['src/lib/flow.ts'], packs: ['realm/effect'] }).filter(
					(finding) => finding.rule === 'EFF15'
				);
			expect(findings()).toHaveLength(1);
			yield* fs.writeFileString(entry, `export default {};`);
			expect(findings()).toEqual([]);
			yield* fs.writeFileString(entry, `import '../lib/flow.js'; export default {};`);
			expect(findings()).toHaveLength(1);
		}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'blocking IO reports only actual callees, including imported and destructured aliases',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-io-callees-' });
			yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
			const cases = [
				[
					`import { readFileSync } from 'node:fs'; export const value = wrap(format(readFileSync('/x', 'utf8')));`,
					1
				],
				[
					`import { readFileSync as read } from 'node:fs'; export const value = read('/x', 'utf8');`,
					1
				],
				[
					`import fs from 'node:fs'; const { readFileSync: read } = fs; export const value = read('/x', 'utf8');`,
					1
				],
				[
					`const { spawnSync: spawn } = require('node:child_process'); export const value = spawn('command');`,
					1
				],
				[
					`import * as fs from 'node:fs'; export const value = fs['readFileSync']('/x', 'utf8');`,
					1
				],
				[
					`import { readFileSync as read } from 'node:fs'; export function value(read: () => string) { return read(); }`,
					0
				],
				[
					`import { readFileSync as read } from 'node:fs'; export function value() { const read = () => 'x'; return read(); }`,
					0
				],
				[
					`import { readFileSync as read } from './memory.js'; export const value = read('/x', 'utf8');`,
					0
				],
				[`export const value = report("readFileSync('/x')");`, 0],
				[
					`import fs from 'fs'; export const value = wrap(fs.readFileSync('/x'), fs.statSync('/x'));`,
					2
				],
				[`export const value = fs.readFile('/x');`, 0]
			] as const;
			const files = cases.map((_, index) => `probe-${index}.ts`);
			for (const [index, [source]] of cases.entries())
				yield* fs.writeFileString(path.join(root, files[index]!), source);
			// one program over every probe, not a cold type check per case
			const found = doctor({ root, files, packs: ['realm/effect'] }).filter(
				(finding) => finding.rule === 'IO1'
			);
			for (const [index, [source, count]] of cases.entries())
				expect(
					found.filter((finding) => finding.location.startsWith(`${files[index]}:`)),
					source
				).toHaveLength(count);
		}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'redundant generators forward one delegated result without other statements or control flow',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-gen-forwarding-' });
			yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
			const cases = [
				[`Effect.gen(function* () { return yield* work; })`, 1],
				[`Effect.gen(function* () { return (yield* work); })`, 1],
				[`(Effect.gen)((function* () { return yield* work; }))`, 1],
				[
					`Effect.gen(function* () { return yield* Effect.suspend(() => Effect.gen(function* () { yield* other; return 1; })); })`,
					1
				],
				[`Effect.gen(function* () { before(); return yield* work; })`, 0],
				[`Effect.gen(function* () { active--; if (active === 0) yield* Latch.open(latch); })`, 0],
				[`Effect.gen(function* () { if (ready) return yield* work; return 0; })`, 0],
				[`Effect.gen(function* () { yield* work; done(); })`, 0],
				[`Effect.gen(function* () { yield* work; })`, 0],
				[`Effect.gen(function* () { return (yield* work) + 1; })`, 0],
				[`Effect.gen(function* () { return yield work; })`, 0],
				[
					`Effect.gen(function* () { const nested = function* () { yield* work; }; return nested; })`,
					0
				],
				[`Effect.gen(function* () { yield* first; return yield* second; })`, 0],
				[`Effect.gen(function* (resume) { return yield* resume(work); })`, 0],
				[`Effect.gen(function* () { try { return yield* work; } finally { finished(); } })`, 0]
			] as const;
			const files = cases.map((_, index) => `probe-${index}.ts`);
			for (const [index, [source]] of cases.entries())
				yield* fs.writeFileString(
					path.join(root, files[index]!),
					`export const value = ${source};`
				);
			// one program over every probe: a program per case is fifteen cold type checks
			const found = doctor({ root, files, packs: ['realm/effect'] }).filter(
				(finding) => finding.rule === 'EFF7'
			);
			for (const [index, [source, count]] of cases.entries())
				expect(
					found.filter((finding) => finding.location.startsWith(`${files[index]}:`)),
					source
				).toHaveLength(count);
		}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'runtime callees report once and only the specified WorkflowSteps callback preserves the caller context',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-runtime-callback-' });
			yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
			const bridge = `export class WorkflowSteps {
 static readonly layer = (step: DurableStep) => Layer.succeed(WorkflowSteps, {
  do: (name: string, effect: Effect.Effect<string>) => Effect.context().pipe(
   Effect.flatMap((context) => Effect.tryPromise({
    try: () => step.do(name, RETRY_OPTIONS, () => Effect.runPromiseWith(context)(effect)),
    catch: workflowFailed(name)
   }))
  )
 });
}`;
			const file = 'apps/analytics-reporter/src/steps.ts';
			yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
			const cases = [
				[file, bridge, 0],
				[file, `${bridge}\nexport const extra = () => Effect.runPromiseWith(context)(work);`, 1],
				[
					file,
					bridge.replace('Effect.runPromiseWith(context)(effect)', 'Effect.runPromise(effect)'),
					1
				],
				[file, bridge.replace('class WorkflowSteps', 'class OtherSteps'), 1],
				[
					file,
					bridge.replace(
						'() => Effect.runPromiseWith(context)(effect)',
						'() => Effect.runPromiseWith(otherContext)(effect)'
					),
					1
				],
				[
					file,
					bridge.replace('step.do(name, RETRY_OPTIONS,', 'step.other(name, RETRY_OPTIONS,'),
					1
				],
				['apps/analytics-reporter/src/helper.ts', bridge, 1],
				[
					'owned.ts',
					`export const run = () => Effect.runPromiseWith(context)(work).then(report);`,
					1
				],
				['owned.ts', `export const runtime = ManagedRuntime.make(layer).runtime();`, 1],
				['owned.ts', `export const context = Context.makeUnsafe(services).pipe(use);`, 1],
				['owned.ts', `export const run = () => wrap(Effect.runSync(work));`, 1],
				['owned.ts', `export const run = () => (Effect.runSync)(work);`, 1]
			] as const;
			const eff8 = (files: ReadonlyArray<string>) =>
				doctor({ root, files: [...files], packs: ['realm/effect'] }).filter(
					(finding) => finding.rule === 'EFF8'
				);
			// the bridge's exception is keyed to its path: those cases share one file, a program each
			for (const [at, source, count] of cases.filter(([at]) => at === file)) {
				yield* fs.writeFileString(path.join(root, at), source);
				expect(eff8([at]), source).toHaveLength(count);
			}
			// the rest are path-independent: one program over a file per case
			const rest = cases
				.filter(([at]) => at !== file)
				.map(([at, source, count], index) => ({
					at: at.replace(/\.ts$/, `-${index}.ts`),
					source,
					count
				}));
			for (const { at, source } of rest) yield* fs.writeFileString(path.join(root, at), source);
			const found = eff8(rest.map(({ at }) => at));
			for (const { at, source, count } of rest)
				expect(
					found.filter((finding) => finding.location.startsWith(`${at}:`)),
					source
				).toHaveLength(count);
		}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'recursive generic contexts and Effect aliases retain precise batch and unknown-error findings',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-recursive-types-' });
			yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
			yield* fs.writeFileString(
				path.join(root, 'owned.ts'),
				`
interface Effect<A, E, R = never> { readonly value: A; readonly error: E; readonly requires: R }
type Job<E, A> = Effect<A, E>;
type Deep<T> = { readonly [K in keyof T]: T[K] extends (...args: infer P) => infer A ? (...args: P) => A : Deep<T[K]> };
interface Recursive { readonly next: Recursive; readonly indexed: { readonly [key: string]: Recursive }; readonly work: Job<ReadError, Recursive> }
interface ReadError { readonly _tag: 'ReadError' }
interface QueryCtx<A> { read(): Job<ReadError, A>; readonly nested: Recursive }
interface Inherited<A> extends QueryCtx<A> {}
type Alias<A> = QueryCtx<A>;
declare namespace Effect {
 function all<A, E>(values: readonly Effect<A, E>[], options?: { readonly concurrency: number }): Effect<readonly A[], E>;
}
declare const recursive: Deep<QueryCtx<Recursive>>;
declare const inherited: Inherited<Recursive>;
declare const alias: Alias<Recursive>;
declare const ordinary: { read(): Job<ReadError, Recursive>; readonly nested: Deep<Recursive> };
declare function erased<A>(value: A): Job<unknown, A>;
declare function typed<A>(value: A): Job<ReadError, A>;
declare function selected(): Job<ReadError, Recursive> | Job<unknown, Recursive>;
export const recursiveBatch = Effect.all([recursive.read()]);
export const inheritedBatch = Effect.all([inherited.read()]);
export const aliasBatch = Effect.all([alias.read()]);
export function genericBatch<C extends QueryCtx<Recursive>>(service: C) { return Effect.all([service.read()]); }
export const concurrentBatch = Effect.all([recursive.read()], { concurrency: 2 });
export const ordinaryBatch = Effect.all([ordinary.read()]);
export const unknownFailure = erased(recursive);
export const typedFailure = typed(recursive);
export const unionFailure = selected();
`
			);
			const found = doctor({ root, files: ['owned.ts'], packs: ['realm/types'] });
			const names = (rule: string) =>
				found
					.filter((finding) => finding.rule === rule)
					.map((finding) => /export (?:const|function) (\w+)/.exec(finding.location)?.[1])
					.sort();
			expect(names('EFF10')).toEqual([
				'aliasBatch',
				'genericBatch',
				'inheritedBatch',
				'recursiveBatch'
			]);
			expect(names('EFF11')).toEqual(['unionFailure', 'unknownFailure']);
		}).pipe(Effect.provide(NodeServices.layer))
);
