// A computed field is a stored generated column: a `unique` constraint and the text search index name it, and an
// output reads it by name. Its CEL zero-pads a drawn `seq` (`series + pad(colour_number, 3)`).
import { expect, layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { split_model } from '../src/decl/model-data.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest as base } from './write-fixture.ts';

const colours = split_model('colours', {
	description: 'Colours',
	record_label: 'record.name',
	fields: {
		name: { kind: 'text' },
		series: { kind: 'text' },
		code: { kind: 'text', computed: 'series + pad(colour_number, 3)' },
		colour_number: { kind: 'seq', per: ['series'] }
	},
	constraints: { one_code: { unique: ['code'] } },
	indexes: { search: { text: ['code'] } },
	outputs: { default: { fields: ['name', 'code'] } },
	create: { fields: ['name', 'series'] }
});
const manifest: EngineManifest = {
	...base,
	models: { colours: colours.model },
	relationships: {},
	exposures: colours.exposure === undefined ? {} : { colours: colours.exposure },
	policies: {},
	teams: {},
	automations: {}
};
const untyped = (acts: { readonly [callable: string]: Json }) => acts;
const Codes = Schema.Struct({
	colours: Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, code: Schema.String })) })
});

layer(TestWorkspace.layer({ manifest, now: '2026-11-14T08:00:00.000Z' }), { excludeTestServices: true })('a computed field', (it) => {
	it.effect('is read by name, matched by text search and held unique', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const admin = yield* t.as(t.admin);
			yield* admin.act(untyped({ 'colours.create': [{ name: 'a', series: 'F' }, { name: 'b', series: 'F' }, { name: 'c', series: 'K' }] }));
			const read = yield* admin.wire_query({ colours: { fields: ['name', 'code'], order_by: 'name' } });
			expect((yield* Schema.decodeUnknownEffect(Codes)(read)).colours.rows.map((row) => row.code)).toEqual(['F001', 'F002', 'K001']);
			const found = yield* admin.wire_query({ colours: { search: 'F002', fields: ['name', 'code'] } });
			expect((yield* Schema.decodeUnknownEffect(Codes)(found)).colours.rows.map((row) => row.name)).toEqual(['b']);
			// ('F1', 1) and ('F', 1001) are distinct series numbers with one code: the unique code refuses the second
			yield* t.db.write({ text: `insert into colours (id, name, series, colour_number) values (gen_random_uuid(), 'd', 'F1', 1)`, params: [] });
			const clash = yield* Effect.flip(
				t.db.write({ text: `insert into colours (id, name, series, colour_number) values (gen_random_uuid(), 'e', 'F', 1001)`, params: [] })
			);
			expect(String(clash)).toMatch(/unique|duplicate/i);
		})
	);
});
