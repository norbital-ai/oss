// The ui exports-list guard (L-BOLT-080, final-ui §2.6; successor of the package-consumer test): the package exposes
// exactly these entries, each built from a source that exists, and the entries carry the §3.6 inputs and the brand.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string | Record<string, string>> };

test('the ui package exports exactly its entries', () => {
	assert.deepEqual(Object.keys(pkg.exports), ['.', './layout', './brand', './capture', './base.css', './assets/*']);
});

test('every built entry has its source', () => {
	for (const [entry, target] of Object.entries(pkg.exports)) {
		if (entry.includes('*')) continue;
		const built = typeof target === 'string' ? target : target['default']!;
		const src = built.replace('./build/', '../src/');
		const candidates = /\.js$/.test(src) ? [src.replace(/\.js$/, '.ts'), src.replace(/\.js$/, '.svelte.ts')] : [src];
		assert.ok(candidates.some((c) => existsSync(new URL(c, import.meta.url))), `${entry} → ${built} has no source`);
		if (typeof target !== 'string') assert.equal(target['types'], built.replace(/\.js$/, '.d.ts'), `${entry} types`);
	}
});

test('the entries name the restored components', () => {
	const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
	assert.match(read('../src/kinds/index.ts'), /NumberTuple, splitNumbers/);
	assert.match(read('../src/brand/index.ts'), /AccretionDisc/);
	assert.match(read('../src/brand/index.ts'), /FEATURE_COLORS/);
	assert.match(read('../src/index.ts'), /event-calendar/);
});
