// A patterned `seq` column reads back as the text stored: seeded or counted, in a caller's read, the kit's stored read
// and a write callback's read in the guest that names it (a default stored row carries no seq or roll-up).
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		people: {
			description: 'People',
			record_label: 'record.name',
			fields: { name: { kind: 'text' }, number: { kind: 'seq', pattern: 'HR-{0000}' } }
		},
		stints: {
			description: 'Stints',
			record_label: 'record.number',
			fields: { person: { kind: 'text' }, number: { kind: 'text', optional: true } }
		}
	},
	relationships: {},
	exposures: {
		people: {
			outputs: { default: { people: { fields: 'all' } } },
			create: { columns: { people: ['name'] } }
		},
		stints: {
			outputs: { default: { stints: { fields: 'all' } } },
			create: { columns: { stints: ['person'] }, transform: true }
		}
	},
	policies: {},
	automations: {}
};
const source = `export default { model: { stints: { bodies: {
	create: function* (changes, ctx) {
		const { people } = yield* ctx.query({ people: { where: { id: { in: changes.map(({ set }) => set.person) } }, fields: ['number'] } });
		const numbers = new Map(people.rows.map((row) => [row.id, row.number]));
		return changes.map(({ set }) => ({ ...set, number: numbers.get(set.person) ?? null }));
	}
} } } };`;
const SEEDED = '0199a000-0000-7000-8000-000000000001';
const untyped = (acts: { readonly [callable: string]: Json }) => acts;
const Rows = Schema.Struct({
	rows: Schema.Array(Schema.Struct({ id: Schema.String, number: Schema.NullOr(Schema.String) }))
});
const People = Schema.Struct({ people: Rows }),
	Stints = Schema.Struct({ stints: Rows });
const workspace = Layer.unwrap(
	program(source).pipe(
		Effect.map((guest) =>
			TestWorkspace.layer({
				manifest,
				guest,
				now: '2026-11-14T08:00:00.000Z',
				seed: { people: [{ id: SEEDED, name: 'Seeded', number: 'HR-0007' }] }
			})
		)
	)
);

layer(workspace, { excludeTestServices: true })('a patterned seq', (it) => {
	it.effect('reads back as its counted text', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const admin = yield* t.as(t.admin);
			const seeded = yield* admin.wire_query({ people: { fields: ['number'] } });
			expect(
				(yield* Schema.decodeUnknownEffect(People)(seeded)).people.rows.map((row) => row.number)
			).toEqual(['HR-0007']);
			yield* admin.act(untyped({ 'people.create': [{ name: 'Ada' }, { name: 'Grace' }] }));
			const read = yield* admin.wire_query({ people: { order_by: 'name' } });
			const people = yield* Schema.decodeUnknownEffect(People)(read);
			expect(people.people.rows.map((row) => row.number)).toEqual([
				'HR-0008',
				'HR-0009',
				'HR-0007'
			]);
			const stored = yield* admin.wire_query(
				{ people: { fields: ['name', 'number'], order_by: 'name' } }
			);
			expect(
				(yield* Schema.decodeUnknownEffect(People)(stored)).people.rows.map((row) => row.number)
			).toEqual(['HR-0008', 'HR-0009', 'HR-0007']);
			yield* admin.act(
				untyped({ 'stints.create': people.people.rows.map((row) => ({ person: row.id })) })
			);
			const stints = yield* admin.wire_query(
				{ stints: { fields: ['number'], order_by: 'number' } }
			);
			expect(
				(yield* Schema.decodeUnknownEffect(Stints)(stints)).stints.rows.map((row) => row.number)
			).toEqual(['HR-0007', 'HR-0008', 'HR-0009']);
		})
	);
});
