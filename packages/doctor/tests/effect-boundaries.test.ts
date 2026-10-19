import { it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { expect } from 'vitest';
import { doctor } from '../src/index.js';

it.live('the strict Effect scope excludes only presentation-only Svelte modules', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-presentation-boundary-' });
		yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
		const presentation = `import { tick } from 'svelte';
export async function measure() { await tick(); return 1; }
export function layout(element: HTMLElement) {
 const observer = new ResizeObserver(() => element.getBoundingClientRect());
 observer.observe(element);
 const frame = requestAnimationFrame(() => element.getBoundingClientRect());
 return () => { observer.disconnect(); cancelAnimationFrame(frame); };
}`;
		const cases = [
			['presentation.svelte', presentation, false],
			['presentation.svelte.ts', presentation, false],
			['ordinary.ts', presentation, true],
			['ui.svelte', `import { Button } from '@norbital-ai/ui';\n${presentation}`, false],
			[
				'prose.svelte',
				`const text = 'fetch localStorage Effect.runPromise';\n${presentation}`,
				false
			],
			['client.svelte', `import { bolt } from '$bolt';\n${presentation}`, true],
			[
				'client-type.svelte',
				`import type { Row } from '@norbital-ai/bolt';\n${presentation}`,
				true
			],
			['client-view.svelte', `import { useBolt } from '@norbital-ai/ui';\n${presentation}`, true],
			[
				'client-view-alias.svelte',
				`import { useBolt as client } from '@norbital-ai/ui';\n${presentation}`,
				true
			],
			[
				'client-view-type.svelte',
				`import type { ViewBolt } from '@norbital-ai/ui';\n${presentation}`,
				true
			],
			[
				'local-client.svelte',
				`import { useBolt } from '../client/context.js';\n${presentation}`,
				true
			],
			[
				'local-client-type.svelte',
				`import type { ViewBolt } from '../client/contract.js';\n${presentation}`,
				true
			],
			[
				'edge.svelte',
				`import { fork as launch } from '@norbital-ai/ui/effect';\n${presentation}`,
				true
			],
			[
				'edge-root.svelte',
				`import { fork as launch } from '@norbital-ai/ui'; launch(work);\n${presentation}`,
				true
			],
			[
				'query-root.svelte',
				`import { query as read } from '@norbital-ai/ui'; read(() => work);\n${presentation}`,
				true
			],
			[
				'mixed.svelte',
				`import { Effect as Fx } from 'effect'; const work = Fx.succeed(1);\n${presentation}`,
				true
			],
			[
				'mixed-namespace.svelte',
				`import * as Fx from 'effect/Effect'; const work = Fx.succeed(1);\n${presentation}`,
				true
			],
			['data-call.svelte', `client.read('notes');\n${presentation}`, true],
			['network.svelte', `const request = fetch; request('/notes');\n${presentation}`, true],
			['socket.svelte', `new WebSocket('wss://example.test');\n${presentation}`, true],
			['storage.svelte', `window['localStorage'].getItem('layout');\n${presentation}`, true],
			['device.svelte', `navigator.geolocation.getCurrentPosition(done);\n${presentation}`, true],
			['worker.svelte', `worker.postMessage({ work: 1 });\n${presentation}`, true]
		] as const;
		for (const [file, script] of cases)
			yield* fs.writeFileString(
				path.join(root, file),
				file.endsWith('.svelte') ? `<script lang="ts">\n${script}\n</script>` : script
			);
		const findings = doctor({ root, files: cases.map(([file]) => file), packs: ['realm/effect'] });
		for (const [file, , owned] of cases) {
			const found = findings.filter(
				(finding) => finding.rule === 'EFF3' && finding.location.startsWith(`${file}:`)
			);
			expect(found.length > 0, file).toBe(owned);
		}
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'typed try boundaries catch only their own callbacks before an Effect execution boundary',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'doctor-throw-boundary-' });
			yield* fs.writeFileString(path.join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
			const cases = [
				[
					"import { Effect } from 'effect'; export const work = Effect.gen(function* () { throw new Error('uncaught'); });",
					true
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.fn('work')(function* () { throw new Error('uncaught'); });",
					true
				],
				[
					"import { Effect as Fx } from 'effect'; export const work = Fx.gen(function* () { throw new Error('uncaught'); });",
					true
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.gen(function* () { return yield* Effect.try(() => { throw new Error('caught'); }); });",
					false
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.gen(function* () { return yield* Effect.try({ try: () => { throw new Error('caught'); }, catch: String }); });",
					false
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.gen(function* () { return yield* Effect.try({ try() { throw new Error('caught'); }, catch: String }); });",
					false
				],
				[
					"import { Effect, Result } from 'effect'; export const work = Effect.gen(function* () { return Result.try(() => { throw new Error('caught'); }); });",
					false
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.gen(function* () { return yield* Effect.tryPromise({ try: async () => { throw new Error('caught'); }, catch: String }); });",
					false
				],
				[
					"import { Effect as Fx, Result as R } from 'effect'; const capture = R.try; export const work = Fx.fnUntraced(function* () { return capture(() => { throw new Error('caught'); }); });",
					false
				],
				[
					"import * as Fx from 'effect/Effect'; import { try as capture } from 'effect/Result'; export const work = Fx.gen(function* () { return capture(() => { throw new Error('caught'); }); });",
					false
				],
				[
					"import { Effect } from 'effect'; const { try: capture } = Effect; export const work = Effect.gen(function* () { return yield* capture(() => { throw new Error('caught'); }); });",
					false
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.try(() => Effect.gen(function* () { throw new Error('deferred'); }));",
					true
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.gen(function* () { return yield* Effect.try(() => Effect.map(other, () => { throw new Error('deferred'); })); });",
					true
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.gen(function* () { const nested = () => { throw new Error('uncaught'); }; return nested(); });",
					true
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.gen(function* () { return yield* Effect.try({ try: read, catch: () => { throw new Error('mapper'); } }); });",
					true
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.gen(function* () { const capture = callback => callback(); return capture(() => { throw new Error('uncaught'); }); });",
					true
				],
				[
					"import { Effect } from 'effect'; export const work = Effect.gen(function* () { return yield* Effect.fail('typed'); });",
					false
				]
			] as const;
			for (const [index, [source]] of cases.entries())
				yield* fs.writeFileString(path.join(root, `case-${index}.ts`), source);
			const findings = doctor({
				root,
				files: cases.map((_, index) => `case-${index}.ts`),
				packs: ['realm/effect']
			});
			for (const [index, [, escapes]] of cases.entries()) {
				const found = findings.filter(
					(finding) => finding.rule === 'EFF6' && finding.location.startsWith(`case-${index}.ts:`)
				);
				expect(found, cases[index]?.[0]).toHaveLength(escapes ? 1 : 0);
			}
		}).pipe(Effect.provide(NodeServices.layer))
);
