import { expect, it } from '@effect/vitest';
import { lintAssertions } from '../src/test/assertions.ts';
import { asserted } from '../src/test/lint.ts';

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
