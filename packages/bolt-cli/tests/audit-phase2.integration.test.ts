// Audit Phase 2, the Bolt half of a cutover: a release's migration that fails once the tenant is paused leaves the
// previous schema and data in place, the previous release keeps serving on them, and the corrected file applies later.
// Pausing admission and flipping releases are the host's (Colony's lifecycle) and are not exercised here.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, it } from '@effect/vitest';
import { Effect, FileSystem, Schema } from 'effect';
import { scratchPath } from '../../../scripts/lib/scratch.ts';
import { prepare_migrations } from '../src/compiler/migrations.ts';
import { TestDb } from '../src/test/database.ts';
import { apply_migrations, read_migrations } from '../../bolt/src/engine/schema/migrations.ts';
import { PgliteDb } from '../../bolt/src/node/db/pglite.ts';
import type { TenantDbShape } from '../../bolt/src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
import { act } from '../../bolt/src/engine/write/act.ts';
import { manifest as base } from '../../bolt/tests/engine-fixture.ts';
import { admin, NOW, TODAY } from '../../bolt/tests/write-fixture.ts';

const before: EngineManifest = {
	...base,
	models: { entry: { description: 'An entry', record_label: 'record.name', fields: { name: { kind: 'text' } } } },
	relationships: {},
	exposures: {
		entry: { outputs: { default: { entry: { fields: 'all' } } }, create: { columns: { entry: ['name'] } } }
	},
	policies: {}
};
const after: EngineManifest = {
	...before,
	models: {
		entry: {
			description: 'An entry',
			record_label: 'record.name',
			fields: { name: { kind: 'text' }, note: { kind: 'text', optional: true } }
		}
	}
};
const Names = Schema.Struct({ name: Schema.String });
const Count = Schema.Struct({ n: Schema.Number });

it.live('a migration failing at cutover leaves the previous release serving and the cutover resumable', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const db = PgliteDb.make(yield* TestDb.open());
			const directory = yield* Effect.acquireRelease(scratchPath(`cutover-${randomUUID()}`), (dir) =>
				fs.remove(dir, { recursive: true, force: true }).pipe(Effect.orDie)
			);
			yield* fs.makeDirectory(directory, { recursive: true });
			const source = join(directory, 'migrations');
			let n = 0;
			const create = (m: EngineManifest, d: TenantDbShape, name: string) =>
				act(
					{ manifest: m, db: d },
					{
						model: 'entry',
						verb: 'create',
						input: [{ name }],
						mode: { _tag: 'Direct' },
						key: `cutover-${n}`,
						invocationId: `cutover-${n++}`,
						issuedAt: NOW,
						authority: admin,
						bindings: { now: NOW, today: TODAY, tz: 'UTC' }
					}
				).pipe(Effect.map((result) => result.outcome.kind));
			const names = db.rows(Names, { text: 'SELECT name FROM entry ORDER BY name', params: [] });
			const noteColumn = db.rows(Count, {
				text: "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'entry' AND column_name = 'note'",
				params: []
			});

			yield* prepare_migrations(directory, before, 'generate');
			yield* apply_migrations(db, before, yield* read_migrations(source));
			expect(yield* create(before, db, 'Before')).toBe('committed');

			// the next release's migration fails only against live rows: a backfill colliding on the primary key
			yield* prepare_migrations(directory, after, 'generate');
			const file = (yield* read_migrations(source)).files[1];
			if (file === undefined) return yield* Effect.die('second migration missing');
			yield* fs.writeFileString(
				join(source, file.name),
				`${file.sql}\ninsert into entry (id, name) select id, 'Duplicate' from entry;\n`
			);
			yield* prepare_migrations(directory, after, 'generate');
			expect(yield* Effect.flip(apply_migrations(db, after, yield* read_migrations(source)))).toMatchObject({
				_tag: 'DbError',
				sqlstate: '23505'
			});
			// nothing of the failed file stays: the previous schema and rows, and the previous release still writes
			expect(yield* noteColumn).toEqual([{ n: 0 }]);
			expect(yield* names).toEqual([{ name: 'Before' }]);
			expect(yield* create(before, db, 'During')).toBe('committed');

			// the corrected file resumes the cutover over everything written meanwhile
			yield* fs.writeFileString(join(source, file.name), file.sql);
			yield* prepare_migrations(directory, after, 'generate');
			yield* apply_migrations(db, after, yield* read_migrations(source));
			expect(yield* noteColumn).toEqual([{ n: 1 }]);
			expect(yield* names).toEqual([{ name: 'Before' }, { name: 'During' }]);
			expect(yield* create(after, db, 'After')).toBe('committed');
		})
	).pipe(Effect.provide(NodeServices.layer))
);
