// The ui exports-list guard (L-BOLT-080, final-ui §2.6; successor of the package-consumer test): the package exposes
// exactly these entries, each built from a source that exists, and the entries carry the §3.6 inputs and the brand.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';

const pkg = Schema.decodeUnknownSync(
	Schema.Struct({
		exports: Schema.Record(
			Schema.String,
			Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])
		)
	})
)(JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')));

it.effect('the ui package exports exactly its entries', () =>
	Effect.sync(() => {
		assert.deepEqual(Object.keys(pkg.exports), [
			'.',
			'./layout',
			'./brand',
			'./capture',
			'./effect',
			'./base.css',
			'./brand/access.css',
			'./assets/*'
		]);
	})
);

it.effect('every built entry has its source', () =>
	Effect.sync(() => {
		for (const [entry, target] of Object.entries(pkg.exports)) {
			if (entry.includes('*')) continue;
			const built = typeof target === 'string' ? target : target['default'];
			assert.ok(built);
			const src = built.replace('./build/', '../src/');
			const candidates = /\.js$/.test(src)
				? [src.replace(/\.js$/, '.ts'), src.replace(/\.js$/, '.svelte.ts')]
				: [src];
			assert.ok(
				candidates.some((c) => existsSync(join(import.meta.dirname, c))),
				`${entry} → ${built} has no source`
			);
			if (typeof target !== 'string')
				assert.equal(target['types'], built.replace(/\.js$/, '.d.ts'), `${entry} types`);
		}
	})
);

it.effect('the entries name the restored components', () =>
	Effect.sync(() => {
		const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8');
		assert.match(read('../src/kinds/index.ts'), /NumberTuple,\s+splitNumbers/);
		assert.match(read('../src/brand/index.ts'), /AccretionDisc/);
		assert.match(read('../src/brand/index.ts'), /FEATURE_COLORS/);
		assert.match(read('../src/index.ts'), /event-calendar/);
	})
);
