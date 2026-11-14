// A `seq` per series: concurrent creates draw distinct numbers, a `per` change redraws, a null `per` draws nothing
// until it is set, a declared `start` floors a series, and the build's data step seeds counters from stored rows.
import { expect, layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { seq_counter_objects } from '../src/engine/schema/engine.ts';
import { migration_schema } from '../src/engine/schema/migrations.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest as base } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		colours: {
			description: 'Colours',
			record_label: 'record.name',
			fields: {
				name: { kind: 'text' },
				series: { kind: 'text', optional: true },
				colour_number: { kind: 'seq', per: ['series'], start: { F: 350, K: 282 }, optional: true }
			}
		}
	},
	relationships: {},
	exposures: {
		colours: {
			outputs: { default: { colours: { fields: 'all' } } },
			create: { columns: { colours: ['name', 'series'] } },
			update: { columns: { colours: ['name', 'series'] } }
		}
	},
	policies: {},
	teams: {},
	automations: {}
};
const untyped = (acts: { readonly [callable: string]: Json }) => acts;
const Colours = Schema.Struct({
	colours: Schema.Struct({
		rows: Schema.Array(
			Schema.Struct({
				id: Schema.String,
				revision: Schema.Number,
				name: Schema.String,
				series: Schema.NullOr(Schema.String),
				colour_number: Schema.NullOr(Schema.Number)
			})
		)
	})
});
const workspace = TestWorkspace.layer({
	manifest,
	now: '2026-11-14T08:00:00.000Z',
	seed: {
		colours: [
			{ id: '0199a000-0000-7000-8000-000000000001', name: 'k-old', series: 'K', colour_number: 100 },
			{ id: '0199a000-0000-7000-8000-000000000002', name: 'm-old', series: 'M', colour_number: 40 }
		]
	}
});

layer(workspace, { excludeTestServices: true })('a seq per series', (it) => {
	it.effect('floors, redraws on a per change, skips a null per and draws distinct numbers concurrently', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const admin = yield* t.as(t.admin);
			const read = Effect.gen(function* () {
				const answer = yield* admin.wire_query({ colours: { order_by: 'name' } });
				return new Map((yield* Schema.decodeUnknownEffect(Colours)(answer)).colours.rows.map((row) => [row.name, row]));
			});
			// the floor holds over a lower stored number; a series without a floor counts on from its highest
			yield* admin.act(untyped({ 'colours.create': [{ name: 'f1', series: 'F' }, { name: 'k1', series: 'K' }, { name: 'm1', series: 'M' }, { name: 'none' }] }));
			let rows = yield* read;
			expect([rows.get('f1')?.colour_number, rows.get('k1')?.colour_number, rows.get('m1')?.colour_number]).toEqual([350, 282, 41]);
			// no draw while the series is null; the row draws when it is first set
			expect(rows.get('none')?.colour_number).toBeNull();
			const none = rows.get('none');
			if (none === undefined) return expect.unreachable();
			yield* admin.act(untyped({ 'colours.update': [{ target: { id: none.id, revision: none.revision }, set: { series: 'F' } }] }));
			rows = yield* read;
			expect(rows.get('none')?.colour_number).toBe(351);
			// a per change redraws from the new series; an update that leaves it keeps the number
			const f1 = rows.get('f1');
			if (f1 === undefined) return expect.unreachable();
			yield* admin.act(untyped({ 'colours.update': [{ target: { id: f1.id, revision: f1.revision }, set: { name: 'f1-renamed' } }] }));
			rows = yield* read;
			const renamed = rows.get('f1-renamed');
			expect(renamed?.colour_number).toBe(350);
			if (renamed === undefined) return expect.unreachable();
			yield* admin.act(untyped({ 'colours.update': [{ target: { id: renamed.id, revision: renamed.revision }, set: { series: 'K' } }] }));
			rows = yield* read;
			expect([rows.get('f1-renamed')?.series, rows.get('f1-renamed')?.colour_number]).toEqual(['K', 283]);
			// setting the series back to null clears the number
			const moved = rows.get('f1-renamed');
			if (moved === undefined) return expect.unreachable();
			yield* admin.act(untyped({ 'colours.update': [{ target: { id: moved.id, revision: moved.revision }, set: { series: null } }] }));
			expect((yield* read).get('f1-renamed')?.colour_number).toBeNull();
			// concurrent creates in one series each draw their own number, none refused
			yield* Effect.all(
				Array.from({ length: 6 }, (_, i) => admin.act(untyped({ 'colours.create': [{ name: `c${i}`, series: 'F' }] }))),
				{ concurrency: 'unbounded' }
			);
			rows = yield* read;
			const drawn = Array.from({ length: 6 }, (_, i) => rows.get(`c${i}`)?.colour_number).sort();
			expect(drawn).toEqual([352, 353, 354, 355, 356, 357]);
		})
	);

	it.effect("the build's data step seeds each counter from its series' highest stored number", () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const admin = yield* t.as(t.admin);
			const objects = seq_counter_objects(migration_schema(manifest).tables);
			expect(objects.map((object) => object.id)).toEqual(['backfill:colours.colour_number']);
			yield* t.db.write({ text: 'delete from bolt_seq', params: [] });
			for (const text of objects.flatMap((object) => object.create)) yield* t.db.write({ text, params: [] });
			yield* admin.act(untyped({ 'colours.create': [{ name: 'm-next', series: 'M' }] }));
			const answer = yield* admin.wire_query({ colours: { where: { name: { eq: 'm-next' } } } });
			expect((yield* Schema.decodeUnknownEffect(Colours)(answer)).colours.rows[0]?.colour_number).toBe(42);
		})
	);
});
