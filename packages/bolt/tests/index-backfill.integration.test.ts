// `bolt.index`: a pack's rows skip the acts that evaluate pure search vectors; the run a pack load queues fills them.
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Result, Schema } from 'effect';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { dynamicRead } from '../src/protocol/read-request.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			swatches: {
				description: 'A swatch',
				label: 'title',
				fields: { title: { kind: 'text' }, r: { kind: 'int' } },
				search: {
					text: ['title'],
					indexes: {
						hue: {
							description: 'Hue',
							dim: 3,
							metric: 'l2',
							input: { r: { kind: 'int' } },
							candidates: 1
						}
					}
				}
			}
		},
		relationships: {},
		exposures: { swatches: { read: { swatches: { fields: 'all' } } } },
		integrations: {},
		policies: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		customFields: {},
		agent: { skills: {} },
		apps: {}
	})
);
const guest = program(`export default { model: { swatches: { bodies: { indexes: { hue: {
	vector: (row) => [row.r, 0, 0],
	probe: (q) => ({ vector: [q.r, 0, 0] }),
} } } } } };`);
const rows = [
	{ id: '01900000-0000-7000-8000-000000000001', title: 'red', r: 200 },
	{ id: '01900000-0000-7000-8000-000000000002', title: 'dark', r: 20 }
];
const workspace = Layer.unwrap(
	Effect.map(guest, (guest) =>
		TestWorkspace.layer({
			manifest,
			guest,
			pack: {
				dir: '',
				rows: { swatches: rows },
				meta: { format: 1, name: 'test', hash: '', start: [], assets: [], rows: { swatches: 2 } }
			}
		})
	)
);

layer(workspace, { excludeTestServices: true })('bolt.index', (it) => {
	it.effect('fills the pure index vectors of a pack’s rows, so a search finds them', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const missing = yield* t.db.rows(Schema.Struct({ n: Schema.Number }), {
				text: `SELECT count(*)::int AS n FROM swatches WHERE "$idx_hue" IS NULL`,
				params: []
			});
			expect(missing).toEqual([{ n: 2 }]);
			yield* t.runDue();
			const found = (r: number) =>
				t
					.as(t.admin)
					.query(dynamicRead({ swatches: { search: { hue: { r } }, limit: 1, fields: ['title'] } }))
					.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Struct({
									swatches: Schema.Struct({
										rows: Schema.Array(Schema.Struct({ title: Schema.String }))
									})
								})
							)
						),
						Effect.map(({ swatches }) => swatches.rows.map((row) => row.title))
					);
			expect(yield* found(200)).toEqual(['red']);
			expect(yield* found(21)).toEqual(['dark']);
		})
	);
});
