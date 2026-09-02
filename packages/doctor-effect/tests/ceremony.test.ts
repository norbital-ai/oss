/**
 * Every ceremony rule reports source that must be reported and none reports source that must not.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runRules, type Rule } from '@norbital-ai/doctor';
import { effectCeremonyRules } from '../build/index.js';

const ALL: ReadonlyArray<Rule> = [...effectCeremonyRules];

type Case = Readonly<{
	rule: string;
	bad: string;
	good: string;
	file?: string;
}>;

const CASES: ReadonlyArray<Case> = [
	{
		rule: 'CEREMONY1',
		bad: 'const text = Effect.runSync(Effect.sync(() => JSON.stringify(value, null, 2)));',
		good: 'const result = Effect.runSync(program);'
	},
	{
		rule: 'CEREMONY2',
		bad: 'void Effect.runPromise(save(record));',
		good: 'void Effect.runPromise(save(record).pipe(Effect.catch(report)));'
	},
	{
		rule: 'CEREMONY3',
		file: 'src/probe.svelte',
		bad: '<script lang="ts">\nconst value = Effect.runSync(program);\n</script>\n',
		good: '<script lang="ts">\nEffect.runFork(save(record).pipe(Effect.catch(report)));\n</script>\n'
	},
	{
		rule: 'CEREMONY4',
		bad: 'const r = Result.succeed(value).pipe(Result.getOrElse(() => fallback));',
		good: 'const r = Result.succeed(value);'
	},
	{
		rule: 'CEREMONY5',
		bad: 'const all = fields.filter(isSystem).concat(fields.filter(isNotSystem));',
		good: 'const [system, rest] = Array.partition(fields, isSystem);'
	}
];

function scan(source: string, file: string, rules: ReadonlyArray<Rule>): ReadonlyArray<string> {
	const root = mkdtempSync(join(tmpdir(), 'doctor-effect-ceremony-'));
	try {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), source);
		writeFileSync(join(root, 'package.json'), '{"name":"ceremony","type":"module"}');
		execFileSync('git', ['init', '-q'], { cwd: root });
		execFileSync('git', ['add', '-A'], { cwd: root });
		return runRules({ root, rules, files: [file] }).map((finding) => finding.rule);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('every ceremony rule reports its positive example', () => {
	const missing: Array<string> = [];
	for (const testCase of CASES) {
		const file = testCase.file ?? 'src/probe.ts';
		const rule = ALL.find((candidate) => candidate.id === testCase.rule);
		assert.ok(rule !== undefined, `${testCase.rule} is not in the ceremony pack`);
		if (!scan(testCase.bad, file, [rule]).includes(testCase.rule))
			missing.push(`${testCase.rule}: no finding for ${testCase.bad.replace(/\n/g, ' ').slice(0, 60)}`);
	}
	assert.deepEqual(missing, [], missing.join('\n'));
});

test('no ceremony rule reports its negative example', () => {
	const spurious: Array<string> = [];
	for (const testCase of CASES) {
		const file = testCase.file ?? 'src/probe.ts';
		const rule = ALL.find((candidate) => candidate.id === testCase.rule);
		assert.ok(rule !== undefined, `${testCase.rule} is not in the ceremony pack`);
		if (scan(testCase.good, file, [rule]).includes(testCase.rule))
			spurious.push(`${testCase.rule}: reported ${testCase.good.replace(/\n/g, ' ').slice(0, 60)}`);
	}
	assert.deepEqual(spurious, [], spurious.join('\n'));
});

test('every ceremony rule has a port case', () => {
	const covered = new Set(CASES.map((testCase) => testCase.rule));
	const uncovered = ALL.map((rule) => rule.id).filter((id) => !covered.has(id));
	assert.deepEqual(uncovered, [], `no port case for: ${uncovered.join(' ')}`);
});
