import { expect, it } from '@effect/vitest';
import { lintAssertions } from '../lint-assertions.ts';

it('refuses non-null assertions and casts, but not `as const`, in TypeScript and Svelte scripts', () => {
	expect(lintAssertions('a.ts', 'const a = [1] as const;\nconst b = x!.y;\nconst c = y as string;')).toEqual([
		'a.ts:2 a non-null assertion',
		'a.ts:3 a type assertion: decode it or fix the producer'
	]);
	expect(lintAssertions('A.svelte', '<div>Hi!</div>\n<script lang="ts">\n\tconst v = w!;\n</script>')).toEqual([
		'A.svelte:3 a non-null assertion'
	]);
});
