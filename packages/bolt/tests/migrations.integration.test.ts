import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Schema } from 'effect';
import { APPLIED, AppliedRow, checksumOf } from '@norbital-ai/store';
import { scratchPath } from '../../../scripts/lib/scratch.ts';
import { prepareMigrations } from '../src/compiler/migrations.ts';
import { applyMigrations, readMigrations } from '../src/engine/schema/migrations.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TestDb } from '../src/test/database.ts';
import type { TenantDbShape } from '../src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { manifest } from './engine-fixture.ts';

const initial: EngineManifest = {
	...manifest,
	models: { entry: { description: 'An entry', label: 'name', fields: { name: { kind: 'text' } } } },
	relationships: {},
	exposures: { entry: { read: { entry: { fields: 'all' } } } },
	policies: {}
};
const extended: EngineManifest = {
	...initial,
	models: {
		entry: {
			description: 'An entry',
			label: 'name',
			fields: {
				name: { kind: 'text' },
				note: { kind: 'text', optional: true }
			}
		}
	}
};
const root = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const directory = yield* scratchPath(`migrations-${randomUUID()}`);
	yield* fs.makeDirectory(directory, { recursive: true });
	return yield* Effect.acquireRelease(Effect.succeed(directory), (directory) =>
		fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie)
	);
});
const ID = '11111111-1111-1111-1111-111111111111';
const Rows = Schema.Struct({ name: Schema.String });
const Count = Schema.Struct({ n: Schema.Number });
const receipts = (db: TenantDbShape) =>
	db.rows(Count, { text: 'select count(*)::int as n from store_migration', params: [] });

// Squash history, `was` renames, drift, snapshot and checksum refusals are Store's (store/tests/migration-history,
// migrate); this file owns Bolt's edge: generated editable source and its application to a live database.
describe('committed workspace migrations', () => {
	it.live('generate keeps an edited file; a history applies once; a refused file rolls back', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				// the kit's database first: the worker's PGlite warm-up is not this file's work
				const db = PgliteDb.make(yield* TestDb.open());
				const directory = yield* root;
				const source = join(directory, 'migrations');
				yield* prepareMigrations(directory, initial, 'generate');
				const bundle = yield* readMigrations(source);
				yield* applyMigrations(db, initial, bundle);
				// applied once: a second apply is a no-op
				yield* applyMigrations(db, initial, bundle);
				expect(yield* receipts(db)).toEqual([{ n: 1 }]);
				expect((yield* db.rows(AppliedRow, { text: APPLIED, params: [] })).map((row) => row.checksum)).toEqual(
					bundle.files.map(checksumOf)
				);

				yield* prepareMigrations(directory, extended, 'generate');
				yield* db.write({ text: 'insert into entry (id, name) values ($1, $2)', params: [ID, 'Kept'] });
				const file = (yield* readMigrations(source)).files[1];
				if (file === undefined) return yield* Effect.die('second migration missing');
				// Scratch replay has no entries; this collision occurs only against the live database's existing row.
				const edited = `${file.sql}\nupdate entry set name = 'Changed';\ninsert into entry (id, name) select id, 'Duplicate' from entry;\n`;
				yield* fs.writeFileString(join(source, file.name), edited);
				yield* prepareMigrations(directory, extended, 'generate');
				expect(yield* fs.readFileString(join(source, file.name))).toBe(edited);
				expect(
					yield* Effect.flip(applyMigrations(db, extended, yield* readMigrations(source)))
				).toMatchObject({ _tag: 'DbError', sqlstate: '23505' });
				expect(yield* db.rows(Rows, { text: 'select name from entry', params: [] })).toEqual([
					{ name: 'Kept' }
				]);
				expect(yield* receipts(db)).toEqual([{ n: 1 }]);
			})
		).pipe(Effect.provide(NodeServices.layer))
	);
});
