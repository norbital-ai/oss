import { expect, it } from '@effect/vitest';
import { lintAssertions } from '../src/test/assertions.ts';
import { asserted, lintTest } from '../src/test/lint.ts';

it('refuses non-null assertions and casts, but not `as const`, in TypeScript and Svelte scripts', () => {
	expect(lintAssertions('a.ts', 'const a = [1] as const;\nconst b = x!.y;\nconst c = y as string;')).toEqual([
		{ line: 2, message: 'a non-null assertion' },
		{ line: 3, message: 'a type assertion: decode it or fix the producer' }
	]);
	expect(lintAssertions('A.svelte', '<div>Hi!</div>\n<script lang="ts">\n\tconst v = w!;\n</script>')).toEqual([
		{ line: 3, message: 'a non-null assertion' }
	]);
});

it('reads modules and components, never declarations, fixtures or generated output', () => {
	const paths = ['src/a.ts', 'src/A.svelte', 'src/a.d.ts', 'tests/fixtures/a.ts', '.norbital/names.ts', 'a.js'];
	expect(paths.filter(asserted)).toEqual(['src/a.ts', 'src/A.svelte']);
});

it('rejects testTimeout/hookTimeout, Bun.sleep, 1-arg numeric setTimeout, and Bun.spawn while allowing zero-delay macrotask yields', () => {
	const sample = [
		`it('a', () => { vi.setConfig({ testTimeout: 60_000 }); });`,
		`it('b', () => { vi.setConfig({ hookTimeout: 30_000 }); });`,
		`it('c', async () => { await Bun.sleep(50); });`,
		`it('d', async () => { await setTimeout(500); });`,
		`it('e', () => { Bun.spawn(['echo', 'hi']); });`,
		`it('f', async () => { await new Promise((r) => setTimeout(r, 0)); await setTimeout(0); });`
	].join('\n');
	expect(lintTest('sample.test.ts', sample)).toEqual([
		'sample.test.ts:1 a timeout option: heavy is not allowed, never raise a limit',
		'sample.test.ts:2 a timeout option: heavy is not allowed, never raise a limit',
		'sample.test.ts:3 a wall-clock wait: use TestClock or wait on the event itself',
		'sample.test.ts:4 a wall-clock wait: use TestClock or wait on the event itself',
		'sample.test.ts:5 a spawned process'
	]);
});
