import { expect, it } from '@effect/vitest';
import { lintAssertions } from '../src/test/assertions.ts';
import { asserted, lintCrossBrowser, lintTest } from '../src/test/lint.ts';

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

it('rejects cross-OS/browser CSS and Svelte regressions while allowing canonical gated patterns', () => {
	expect(
		lintCrossBrowser(
			'packages/ui/src/base.css',
			[
				'::-webkit-scrollbar { width: 8px; }',
				'.bounded { scrollbar-width: none; }',
				'@supports not selector(::-webkit-scrollbar) {',
				'  * { scrollbar-width: thin; scrollbar-color: transparent transparent; }',
				'}',
				'/* scrollbar-gutter: stable in a comment is ignored */',
				'.bad { scrollbar-width: thin; }',
				'.bad2 { scrollbar-color: red transparent; }'
			].join('\n')
		)
	).toEqual([
		'packages/ui/src/base.css:7 ungated scrollbar-width/scrollbar-color disables ::-webkit-scrollbar in Chromium 121+: gate with @supports not selector(::-webkit-scrollbar) or use scrollbar-width: none',
		'packages/ui/src/base.css:8 ungated scrollbar-width/scrollbar-color disables ::-webkit-scrollbar in Chromium 121+: gate with @supports not selector(::-webkit-scrollbar) or use scrollbar-width: none'
	]);

	expect(
		lintCrossBrowser(
			'apps/website/src/app.css',
			'.code::-webkit-scrollbar { height: 8px; }\n.box { scrollbar-gutter: stable; height: 80vh; }'
		)
	).toEqual([
		'apps/website/src/app.css:1 custom ::-webkit-scrollbar belongs only in @norbital-ai/ui/src/base.css',
		'apps/website/src/app.css:2 scrollbar-gutter: stable reserves a classic gutter on Windows/Chrome that macOS overlay scrollbars do not',
		'apps/website/src/app.css:2 legacy vh/h-screen ignores dynamic mobile browser chrome: use dvh or svh'
	]);

	expect(
		lintCrossBrowser(
			'apps/website/src/Page.svelte',
			'<div class="min-h-svh max-h-[80dvh]"><button>☀</button></div>\n<div class="min-h-screen [scrollbar-gutter:stable]"></div>'
		)
	).toEqual([
		'apps/website/src/Page.svelte:1 raw Unicode symbol renders differently across OS fonts: use an SVG <Icon>',
		'apps/website/src/Page.svelte:2 scrollbar-gutter: stable reserves a classic gutter on Windows/Chrome that macOS overlay scrollbars do not',
		'apps/website/src/Page.svelte:2 legacy vh/h-screen ignores dynamic mobile browser chrome: use dvh or svh'
	]);
});
