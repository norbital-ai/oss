/// <reference types="node" />
// `@norbital-ai/bolt/type-service` (compute model §5, "Check: one type service for every tenant", "The language tool"):
// parity with svelte-check first (the same errors on deliberately wrong `.ts` and `.svelte` fixtures), then the
// language operations at editor positions in both, unsaved buffers, tenants kept apart in one process, a type probe,
// recycling past a budget and a request past its ceiling.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, layer } from '@effect/vitest';
import { Effect, Option, Schema } from 'effect';
import {
	layer as typeService,
	TypeService,
	type LangWorkspace
} from '../src/type-service/index.ts';

const MODULES = fileURLToPath(new URL('../node_modules', import.meta.url));
const GOOD = {
	'tsconfig.json': JSON.stringify({
		compilerOptions: {
			target: 'ES2022',
			module: 'ESNext',
			moduleResolution: 'bundler',
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			verbatimModuleSyntax: true,
			types: []
		},
		include: ['src/**/*.ts', 'src/**/*.svelte']
	}),
	'src/total.ts':
		'/** The sum of two amounts. */\nexport function total(a: number, b: number): number {\n\treturn a + b;\n}\n',
	'src/use.ts': "import { total } from './total';\nexport const sum = total(1, 2);\n",
	'src/Card.svelte':
		'<script lang="ts">\n\tlet { title }: { title: string } = $props();\n\tconst size: number = title.length;\n</script>\n\n<h1>{title} ({size})</h1>\n',
	'src/Async.svelte':
		'<script lang="ts">\n\tconst title: string = await Promise.resolve("Ready");\n</script>\n<p>{title}</p>\n',
	'src/Page.svelte':
		"<script lang=\"ts\">\n\timport Card from './Card.svelte';\n\timport { sum } from './use';\n</script>\n\n<Card title={`total ${sum}`} />\n"
};
/** One deliberate error each: a `.ts` file, a component's script, a component's markup. */
const WRONG = {
	'src/bad.ts': 'export const wrong: string = 1;\n',
	'src/Bad.svelte':
		'<script lang="ts">\n\tconst count: number = \'many\';\n</script>\n\n<p>{count}</p>\n',
	'src/BadUse.svelte':
		'<script lang="ts">\n\timport Card from \'./Card.svelte\';\n</script>\n\n<Card title={42} />\n'
};
const EXPECTED = ['src/Bad.svelte:2:2322', 'src/BadUse.svelte:5:2322', 'src/bad.ts:1:2322'];
const ws = (
	tenant: string,
	files: { readonly [path: string]: string } = GOOD,
	key = `${tenant}/live`
): LangWorkspace => ({ tenant, key, files: new Map(Object.entries(files)), modules: MODULES });

const SvelteCheckLine = Schema.Struct({
	type: Schema.String,
	filename: Schema.String,
	start: Schema.Struct({ line: Schema.Number }),
	code: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
	source: Schema.optionalKey(Schema.String)
});
/** svelte-check (TypeScript 6 underneath) over the same files on disk: its type errors as `path:line:code`. */
const svelteCheck = (files: { readonly [path: string]: string }) =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const dir = mkdtempSync(join(tmpdir(), 'norbital-svelte-check-'));
			for (const [path, text] of Object.entries(files)) {
				mkdirSync(dirname(join(dir, path)), { recursive: true });
				writeFileSync(join(dir, path), text);
			}
			symlinkSync(MODULES, join(dir, 'node_modules'));
			return dir;
		}),
		(dir) =>
			Effect.sync(() => {
				const bin = join(
					dirname(createRequire(import.meta.url).resolve('svelte-check/package.json')),
					'bin',
					'svelte-check'
				);
				const out = spawnSync(
					process.execPath,
					[
						bin,
						'--workspace',
						dir,
						'--tsconfig',
						'./tsconfig.json',
						'--output',
						'machine-verbose',
						'--diagnostic-sources',
						'js',
						'--threshold',
						'error'
					],
					{ cwd: dir, encoding: 'utf8' }
				).stdout;
				return out
					.split('\n')
					.flatMap((line) =>
						Option.toArray(
							Schema.decodeUnknownOption(Schema.fromJsonString(SvelteCheckLine))(
								line.slice(line.indexOf(' ') + 1)
							)
						)
					)
					.filter((d) => d.type === 'ERROR')
					.map((d) => `${d.filename}:${d.start.line + 1}:${d.code}`)
					.sort();
			}),
		(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
	);

layer(typeService(), { timeout: 60_000, excludeTestServices: true })('the type service', (it) => {
	it.effect(
		'reports the type errors svelte-check reports, in .ts files, component scripts and component markup',
		() =>
			Effect.gen(function* () {
				const lang = yield* TypeService;
				const files = { ...GOOD, ...WRONG };
				const ours = (yield* lang.diagnose(ws('parity', files))).answer
					.filter((d) => d.category === 'error')
					.map((d) => `${d.path}:${d.line}:${d.code}`)
					.sort();
				expect(ours).toEqual(EXPECTED);
				expect(yield* svelteCheck(files)).toEqual(ours);
				expect((yield* lang.diagnose(ws('parity-clean'))).answer).toEqual([]);
			}),
		120_000
	);

	it.effect(
		'hovers, follows and finds a symbol, outlines a file and answers its signature',
		() =>
			Effect.gen(function* () {
				const lang = yield* TypeService;
				const at = { path: 'src/use.ts', line: 2, column: 20 };
				const hover = (yield* lang.hover(ws('a'), at)).answer;
				expect(hover).toMatchObject({
					name: 'total',
					type: '(a: number, b: number) => number',
					docs: 'The sum of two amounts.',
					at: { path: 'src/total.ts', line: 2, column: 17 }
				});
				expect((yield* lang.definition(ws('a'), at)).answer).toEqual({
					path: 'src/total.ts',
					line: 2,
					column: 17
				});
				const refs = (yield* lang.references(ws('a'), at)).answer.map((r) => `${r.path}:${r.line}`);
				expect(refs).toEqual(
					expect.arrayContaining(['src/total.ts:2', 'src/use.ts:1', 'src/use.ts:2'])
				);
				expect((yield* lang.outline(ws('a'), 'src/total.ts')).answer).toEqual([
					{ kind: 'FunctionDeclaration', name: 'total', line: 2 }
				]);
				expect((yield* lang.signature(ws('a'), at)).answer).toEqual([
					'(a: number, b: number) => number'
				]);
			}),
		60_000
	);

	it.effect(
		'answers inside a component as in a .ts file, and maps its references back to the component',
		() =>
			Effect.gen(function* () {
				const lang = yield* TypeService;
				const size = (yield* lang.hover(ws('a'), { path: 'src/Card.svelte', line: 3, column: 8 }))
					.answer;
				expect(size).toMatchObject({
					name: 'size',
					type: 'number',
					at: { path: 'src/Card.svelte', line: 3, column: 8 }
				});
				const sum = (yield* lang.references(ws('a'), { path: 'src/use.ts', line: 2, column: 14 }))
					.answer;
				expect(sum.map((r) => `${r.path}:${r.line}`)).toEqual(
					expect.arrayContaining(['src/use.ts:2', 'src/Page.svelte:3', 'src/Page.svelte:6'])
				);
			}),
		60_000
	);

	it.effect(
		'answers unsaved buffers as typed, and only in the tenant that typed them',
		() =>
			Effect.gen(function* () {
				const lang = yield* TypeService;
				const typed = {
					...GOOD,
					'src/use.ts':
						"import { total } from './total';\nexport const sum: string = total(1, 2);\nsum.\n"
				};
				const edited = (yield* lang.diagnose(ws('b', typed), 'src/use.ts')).answer;
				expect(edited.map((d) => `${d.line}:${d.code}`)).toContain('2:2322');
				const completions = (yield* lang.completions(ws('b', typed), {
					path: 'src/use.ts',
					line: 3,
					column: 5
				})).answer;
				expect(completions.map((c) => c.name)).toContain('toUpperCase');
				expect((yield* lang.diagnose(ws('c'), 'src/use.ts')).answer).toEqual([]);
				expect((yield* lang.diagnose(ws('b'), 'src/use.ts')).answer).toEqual([]);
			}),
		60_000
	);

	it.effect(
		'forgets one tenant and fences its prepared requests while another tenant keeps editing',
		() =>
			Effect.gen(function* () {
				const lang = yield* TypeService;
				const dirty = { ...GOOD, 'src/use.ts': 'export const value: string = 1;\n' };
				expect((yield* lang.diagnose(ws('forget', dirty), 'src/use.ts')).answer).not.toEqual([]);
				expect((yield* lang.diagnose(ws('keep', dirty), 'src/use.ts')).answer).not.toEqual([]);
				const prepared = lang.diagnose(ws('forget', dirty), 'src/use.ts');
				yield* lang.forget('forget');
				expect(yield* prepared.pipe(Effect.flip)).toMatchObject({ reason: 'failed' });
				expect((yield* lang.diagnose(ws('keep', dirty), 'src/use.ts')).answer).not.toEqual([]);
				expect((yield* lang.diagnose(ws('forget'), 'src/use.ts')).answer).toEqual([]);
			}).pipe(Effect.provide(typeService({ lanes: 1 })))
	);

	it.effect(
		"evaluates a type over the workspace's program, expanded at the top",
		() =>
			Effect.gen(function* () {
				const lang = yield* TypeService;
				const probe = (yield* lang.type(ws('a'), {
					imports: "import type { total } from '../src/total';",
					type: '{ result: ReturnType<typeof total> }'
				})).answer;
				expect(probe?.type).toBe('{ result: number; }');
			}),
		60_000
	);

	it.effect(
		'refuses a file the workspace does not hold',
		() =>
			Effect.gen(function* () {
				const lang = yield* TypeService;
				const failure = yield* Effect.flip(
					lang.hover(ws('a'), { path: 'src/none.ts', line: 1, column: 1 })
				);
				expect(failure.reason).toBe('unknownFile');
			}),
		60_000
	);
});

layer(typeService({ budgetMiB: 1 }), { excludeTestServices: true })('a 1 MiB budget', (it) => {
	it.effect(
		'replaces a process past its budget, gives a project over half of it a process of its own, and stays correct',
		() =>
			Effect.gen(function* () {
				const lang = yield* TypeService;
				const at = { path: 'src/use.ts', line: 2, column: 14 };
				for (let i = 0; i < 3; i++) {
					const hover = yield* lang.hover(ws('r'), at);
					expect(hover.answer?.type).toBe('number');
					expect(hover.cpuMs).toBeGreaterThanOrEqual(0);
				}
			}),
		60_000
	);
});

layer(typeService({ requestMs: 1 }), { excludeTestServices: true })('a 1 ms ceiling', (it) => {
	it.effect(
		'ends a request past it',
		() =>
			Effect.gen(function* () {
				const lang = yield* TypeService;
				const failure = yield* Effect.flip(lang.diagnose(ws('slow'), 'src/use.ts'));
				expect(failure.reason).toBe('timeout');
			}),
		60_000
	);
});
