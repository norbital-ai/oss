/**
 * Port acceptance for the Effect ownership rules: every rule reports source that must be
 * reported and none reports source that must not.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runRules, type Rule } from '@norbital-ai/doctor';
import { effectRules } from '../build/index.js';

const ALL: ReadonlyArray<Rule> = [...effectRules];
const PRELUDE = "import { Effect } from 'effect';\nconst owned = Effect.succeed(1);\n";

type Case = Readonly<{
	rule: string;
	bad: string;
	good: string;
	file?: string;
	fixture?: Readonly<Record<string, string>>;
}>;

const CASES: ReadonlyArray<Case> = [
	{
		rule: 'EFF1',
		bad: `${PRELUDE}export const f = () => { try { go(); } catch (e) { report(e); } };`,
		good: `${PRELUDE}export const f = () => Effect.try(go);`
	},
	{
		rule: 'EFF2',
		bad: `${PRELUDE}export const f = () => Promise.all([a, b]);`,
		good: `${PRELUDE}export const f = () => Effect.all([a, b]);`
	},
	{
		rule: 'EFF3',
		bad: `${PRELUDE}export async function f() { return 1; }`,
		good: `${PRELUDE}export const f = Effect.succeed(1);`
	},
	{
		rule: 'EFF5',
		bad: `${PRELUDE}export const f = Effect.gen(function* () { const t = Date.now(); return yield* Effect.succeed(t); });`,
		good:
			`${PRELUDE}export const f = Effect.gen(function* () { return yield* Clock.currentTimeMillis; });\n` +
			`export const g = Effect.gen(function* () { const m = yield* Clock.currentTimeMillis; return new Date(m); });`
	},
	{
		rule: 'EFF6',
		bad: `${PRELUDE}export const f = Effect.gen(function* () { throw new Error('x'); });`,
		good: `${PRELUDE}export const f = Effect.gen(function* () { return yield* Effect.fail('x'); });`
	},
	{
		rule: 'EFF7',
		bad: `${PRELUDE}export const f = Effect.gen(function* () { return yield* Effect.succeed(1); });`,
		good: `${PRELUDE}export const f = Effect.succeed(1);`
	},
	{
		rule: 'NONDET1',
		bad: `${PRELUDE}export const id = Effect.succeed(Math.random());`,
		good: `${PRELUDE}export const id = Effect.succeed(0);`
	},
	{
		rule: 'EQ1',
		bad: 'export const s = JSON.stringify(a) === JSON.stringify(b);',
		good: 'export const s = Equal.equals(a, b);'
	},
	{
		rule: 'LOG1',
		bad: "export const f = () => console.log('x');",
		good: "export const f = () => Effect.log('x');"
	},
	{
		rule: 'IO1',
		bad: "import { readFileSync } from 'node:fs';\nexport const f = () => readFileSync('/x', 'utf8');",
		good: "export const f = () => fs.readFile('/x');"
	},
	{
		rule: 'STATE1',
		bad: 'export let shared: number[] = [];',
		good: 'export const shared: ReadonlyArray<number> = [];'
	}
];

function scan(
	source: string,
	file: string,
	rules: ReadonlyArray<Rule>,
	fixture?: Readonly<Record<string, string>>
): ReadonlyArray<string> {
	const root = mkdtempSync(join(tmpdir(), 'doctor-effect-port-'));
	try {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), source);
		writeFileSync(join(root, 'package.json'), '{"name":"port","type":"module"}');
		for (const [name, contents] of Object.entries(fixture ?? {})) {
			mkdirSync(dirname(join(root, name)), { recursive: true });
			writeFileSync(join(root, name), contents);
		}
		execFileSync('git', ['init', '-q'], { cwd: root });
		execFileSync('git', ['add', '-A'], { cwd: root });
		return runRules({ root, rules, files: [file] }).map((finding) => finding.rule);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('every ported rule reports its positive example', () => {
	const missing: Array<string> = [];
	for (const testCase of CASES) {
		const file = testCase.file ?? 'src/probe.ts';
		const rule = ALL.find((candidate) => candidate.id === testCase.rule);
		assert.ok(rule !== undefined, `${testCase.rule} is not in the Effect pack`);
		if (!scan(testCase.bad, file, [rule], testCase.fixture).includes(testCase.rule))
			missing.push(
				`${testCase.rule}: no finding for ${testCase.bad.replace(/\n/g, ' ').slice(0, 60)}`
			);
	}
	assert.deepEqual(missing, [], missing.join('\n'));
});

test('no ported rule reports its negative example', () => {
	const spurious: Array<string> = [];
	for (const testCase of CASES) {
		const file = testCase.file ?? 'src/probe.ts';
		const rule = ALL.find((candidate) => candidate.id === testCase.rule);
		assert.ok(rule !== undefined, `${testCase.rule} is not in the Effect pack`);
		if (scan(testCase.good, file, [rule], testCase.fixture).includes(testCase.rule))
			spurious.push(`${testCase.rule}: reported ${testCase.good.replace(/\n/g, ' ').slice(0, 60)}`);
	}
	assert.deepEqual(spurious, [], spurious.join('\n'));
});

test('every Effect rule has a port case', () => {
	const covered = new Set(CASES.map((testCase) => testCase.rule));
	const uncovered = ALL.map((rule) => rule.id).filter((id) => !covered.has(id));
	assert.deepEqual(uncovered, [], `no port case for: ${uncovered.join(' ')}`);
});

test('Effect ownership excludes schema-only, type-only and unused imports', () => {
	const rules = ALL.filter((rule) => ['EFF1', 'EFF2', 'EFF3', 'EFF5'].includes(rule.id));
	for (const imports of [
		"import { Schema } from 'effect'; const codec = Schema.String;",
		"import type { Effect } from 'effect';",
		"import { Effect } from 'effect';"
	]) {
		assert.deepEqual(
			scan(
				`${imports} async function native() { try { await Promise.all([]); } catch {} }`,
				'src/probe.ts',
				rules
			),
			[]
		);
	}
	for (const runtime of [
		"import { Effect as E } from 'effect'; const owned = E.succeed(1);",
		"import * as E from 'effect/Effect'; const owned = E.succeed(1);",
		"import { succeed as own } from 'effect/Effect'; const owned = own(1);",
		"import * as E from 'effect'; const owned = E.Effect.succeed(1);"
	]) {
		const found = scan(
			`${runtime} async function native() { try { await Promise.all([]); } catch {} }`,
			'src/probe.ts',
			rules
		);
		assert.ok(found.includes('EFF1'), runtime);
		assert.ok(found.includes('EFF2'), runtime);
	}
});
