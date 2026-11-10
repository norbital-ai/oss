import { it, expect } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PgliteDb, Pristine } from '../src/node/db/pglite.ts';
import { StoreError } from '@norbital-ai/store';
import { auditMigrationProof, readAuditMigrations } from '../src/node/audit-migrations.ts';

it.live('proves the native audit history against its declaration', () =>
	Effect.gen(function* () {
		const migrations = yield* readAuditMigrations(true);
		const proof = yield* auditMigrationProof(
			migrations.spec,
			migrations.files,
			migrations.snapshot
		);
		expect(proof.lock).toBe(migrations.lock);
		expect(proof.physical).toBe(migrations.physical);
	})
);

it.live('rejects an audit migration that grants public access', () =>
	Effect.gen(function* () {
		const migrations = yield* readAuditMigrations(true);
		const edited = migrations.files.map((file, index) =>
			index !== migrations.files.length - 1
				? file
				: { ...file, sql: `${file.sql}\nGRANT USAGE ON SCHEMA bolt_audit TO PUBLIC;\n` }
		);
		const refused = yield* Effect.flip(
			auditMigrationProof(migrations.spec, edited, migrations.snapshot)
		);
		expect(refused).toBeInstanceOf(StoreError);
		if (refused instanceof StoreError) expect(refused.code).toBe('migrationChanged');
	})
);

it.live('migrates audit envelope names and restores immutability while preserving payloads', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const pristine = yield* yield* Pristine;
			for (const scoped of [false, true]) {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const pg = yield* Effect.acquireRelease(
							Effect.promise(() =>
								PGlite.create({ loadDataDir: pristine, extensions: { pg_trgm } })
							),
							(pg) => Effect.promise(() => pg.close())
						);
						const db = PgliteDb.make(pg);
						const migrations = yield* readAuditMigrations(scoped);
						const cut = migrations.files.find((file) => file.name === '0004_authoring_names.sql');
						if (cut === undefined)
							return yield* Effect.die('The authoring-name migration is missing.');
						for (const file of migrations.files.filter((file) => file.name < cut.name))
							yield* db.write({ text: file.sql, params: [] });
						const original = {
							id: 'retained',
							operationId: 'operation',
							at: '2001-01-01T00:00:00.000Z',
							category: 'write',
							action: 'entries.update',
							status: 'pendingApproval',
							actor: { kind: 'apiKey', id: 'key' },
							subject: null,
							invocation: 'invocation',
							transaction: null,
							run: null,
							approval: null,
							payload: { text: 'pendingApproval apiKey requestChanges', unchanged: { value: 42 } }
						};
						yield* db.write(
							scoped
								? {
										text: 'SELECT bolt_audit.append($1, $2, $3, $4::jsonb)',
										params: ['platform', 'tenant', 'live', [original]]
									}
								: { text: 'SELECT bolt_audit.append($1::jsonb)', params: [[original]] }
						);
						yield* db.write({ text: cut.sql, params: [] });
						const rows = yield* db.rows(Schema.Struct({ event: Schema.Json }), {
							text: 'SELECT event FROM bolt_audit.event',
							params: []
						});
						expect(rows).toEqual([
							{
								event: {
									...original,
									status: 'pending_approval',
									actor: { kind: 'api_key', id: 'key' }
								}
							}
						]);
						const refused = yield* Effect.flip(
							db.write({
								text: "UPDATE bolt_audit.event SET event = jsonb_set(event, '{action}', '\"changed\"'::jsonb)",
								params: []
							})
						);
						expect(refused.sqlstate).toBe('BA101');
					})
				);
			}
		})
	).pipe(Effect.provide(Pristine.layer))
);
