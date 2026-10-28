/**
 * A rule the engine cannot evaluate is refused when its pack loads, never compiled to a matcher that reports nothing:
 * zero findings must mean clean. The front-end model (svelte, css, trivia and sql kinds) has no TypeScript-only arm and
 * binds no metavariables; a rule's `files` and `ignore` are platform globs, `?` included.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { doctor } from '../src/index.ts';

/** Load a pack holding one rule, `PROBE`, and run it over `files`; answers the files it reported. */
function probe(
	rule: Readonly<Record<string, unknown>>,
	files: Readonly<Record<string, string>> = {}
): string[] {
	const scratch = mkdtempSync(join(tmpdir(), 'doctor-probe-'));
	try {
		const pack = join(scratch, 'pack');
		const root = join(scratch, 'repo');
		mkdirSync(pack);
		mkdirSync(root);
		// JSON is YAML.
		writeFileSync(
			join(pack, 'PROBE.yaml'),
			JSON.stringify({
				id: 'PROBE',
				summary: 'probe',
				severity: 'error',
				principles: ['simplicity'],
				examples: { bad: ['x'], good: ['y'] },
				...rule
			})
		);
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		return doctor({ root, files: Object.keys(files), packs: [pack] })
			.filter((f) => f.rule === 'PROBE')
			.map((f) => f.location.split(':')[0] ?? '');
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** A model rule (it names a `svelte:` kind) whose `has` holds `matcher`. */
const model = (matcher: unknown) => ({ all: [{ kind: 'svelte:Element' }, { has: matcher }] });
const refused = (arm: string) =>
	new RegExp(
		`PROBE uses \`${arm.replace('.', '\\.')}\`, which the front-end model cannot evaluate`
	);

it.effect('alias coverage reads JSONC without stripping wildcard path strings', () =>
	Effect.sync(() => {
		assert.deepEqual(
			probe(
				{ rule: { all: [{ kind: 'ImportDeclaration' }, { aliasCovered: true }] } },
				{
					'tsconfig.json': `{
						// A wildcard may be followed by a path segment.
						"compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*/index.ts"], }, },
					}`,
					'src/feature/panel/probe.ts': "import { value } from '../../lib/value/index.js';",
					'src/lib/value/index.ts': 'export const value = 1;'
				}
			),
			['src/feature/panel/probe.ts']
		);
	})
);

const TS_ONLY: Readonly<Record<string, unknown>> = {
	pattern: { pattern: { context: 'foo()', selector: 'CallExpression' } },
	nthChild: { nthChild: 1 },
	range: { range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } },
	follows: { follows: 'foo()' },
	precedes: { precedes: 'foo()' },
	matches: { matches: 'call' },
	selfModule: { selfModule: true },
	aliasCovered: { aliasCovered: true },
	importsFrom: { importsFrom: 'effect' },
	count: { count: { min: 1, of: 'foo()' } },
	calls: { calls: { of: 'X', exactly: 1 } }
};

for (const [arm, matcher] of Object.entries(TS_ONLY))
	it.effect(`a model rule using \`${arm}\` is refused at load, naming the rule and the arm`, () =>
		Effect.sync(() => {
			assert.throws(() => probe({ rule: model(matcher), utils: { call: 'foo()' } }), refused(arm));
		})
	);

it.effect(
	'a model rule whose stopBy is a rule, or whose regex reads a metavariable, is refused at load',
	() =>
		Effect.sync(() => {
			const stop = { kind: 'svelte:Element' };
			assert.throws(
				() =>
					probe({
						rule: {
							all: [{ kind: 'svelte:Element' }, { has: { kind: 'svelte:Name' }, stopBy: stop }]
						}
					}),
				refused('has.stopBy')
			);
			assert.throws(
				() =>
					probe({
						rule: {
							all: [{ kind: 'svelte:Element' }, { inside: { kind: 'svelte:Block' }, stopBy: stop }]
						}
					}),
				refused('inside.stopBy')
			);
			assert.throws(
				() => probe({ rule: { all: [{ kind: 'svelte:Element' }, { regex: 'x', on: 'X' }] } }),
				refused('regex.on')
			);
		})
);

it.effect(
	'a model rule with constraints is refused at load: the model binds no metavariable for one to narrow',
	() =>
		Effect.sync(() => {
			assert.throws(
				() => probe({ rule: model('$X'), constraints: { X: { kind: 'Identifier' } } }),
				/PROBE constrains \$X, which a front-end model rule never binds/
			);
		})
);

it.effect('a model rule the model evaluates still loads and reports', () =>
	Effect.sync(() => {
		const files = {
			'src/A.svelte': '<div class="h-4"></div>\n',
			'src/B.svelte': '<div class="w-4"></div>\n'
		};
		assert.deepEqual(
			probe({ rule: { all: [{ kind: 'svelte:ClassToken' }, { regex: '^h-' }] } }, files),
			['src/A.svelte']
		);
	})
);

it.effect('`files` and `ignore` are globs: `?` is one character, `*` stays inside a segment', () =>
	Effect.sync(() => {
		const files = {
			'src/a.ts': 'debugger;\n',
			'src/a1.ts': 'debugger;\n',
			'src/a12.ts': 'debugger;\n',
			'src/deep/a2.ts': 'debugger;\n'
		};
		assert.deepEqual(probe({ rule: { kind: 'DebuggerStatement' }, files: ['src/a?.ts'] }, files), [
			'src/a1.ts'
		]);
		assert.deepEqual(
			probe(
				{ rule: { kind: 'DebuggerStatement' }, files: ['src/*.ts'], ignore: ['src/a?.ts'] },
				files
			).sort(),
			['src/a.ts', 'src/a12.ts']
		);
	})
);
