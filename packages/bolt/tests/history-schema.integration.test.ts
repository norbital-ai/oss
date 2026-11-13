import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { PgliteDb, Pristine } from '../src/node/db/pglite.ts';
import { schema_slice } from '../src/engine/schema/plan.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { read_history, prune_history } from '../src/engine/query/history.ts';
import { HistorySchema, historyKinds } from '../src/engine/query/history-schema.ts';
import { acknowledgeAudit, drainAuditErases } from '../src/engine/audit-retention.ts';
import { HistorySnapshotSchema } from '../src/protocol/record-contracts.ts';
import { restorePreview, restoreRecord } from '../src/engine/write/restore.ts';
import { act } from '../src/engine/write/act.ts';
import { compile_authority } from '../src/engine/access/authority.ts';
import { IdentityStatement, identityPiece, identityHistory } from '../src/engine/identity/session.ts';
import {
	admin,
	arm,
	grants,
	authority,
	member,
	NOW,
	TODAY,
	manifest as base
} from './write-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const bindings = { now: NOW, today: TODAY, tz: 'UTC' };
const before: EngineManifest = {
	...base,
	relationships: {},
	policies: {},
	models: {
		documents: {
			description: 'Documents',
			record_label: 'record.title',
			fields: {
				title: { kind: 'text' },
				quantity: { kind: 'text', optional: true },
				removed: { kind: 'text', optional: true },
				secret: { kind: 'text', optional: true }
			}
		}
	},
	exposures: {
		documents: {
			outputs: { default: { documents: { fields: 'all' } } },
			update: { columns: { documents: ['title', 'quantity', 'removed', 'secret'] } }
		}
	}
};
const after: EngineManifest = {
	...before,
	models: {
		articles: {
			description: 'Articles',
			was: 'documents',
			record_label: 'record.heading',
			fields: {
				heading: { kind: 'text', was: 'title' },
				quantity: { kind: 'int', optional: true },
				secret: { kind: 'text', optional: true }
			}
		}
	},
	exposures: {
		articles: {
			outputs: { default: { articles: { fields: 'all' } } },
			update: { columns: { articles: ['heading', 'quantity', 'secret'] } }
		}
	}
};

describe('versioned record history', () => {
	it.live(
		'a restored database checkpoint contains the old schema and only the earlier writes',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const pg = yield* PgliteDb.open();
					const db = PgliteDb.make(pg);
					const initial = schema_slice(before);
					yield* TestDb.migrate(db, initial);
					yield* db.write({
						text: "INSERT INTO documents(id,title) VALUES ($1,'Earlier')",
						params: [ID]
					});
					const checkpoint = yield* PgliteDb.dump(pg);
					yield* TestDb.migrate(db, after, { accept: true });
					yield* db.write({
						text: "INSERT INTO articles(id,heading) VALUES (gen_random_uuid(),'Later')",
						params: []
					});
					const restored = PgliteDb.make(yield* PgliteDb.open(checkpoint));
					expect(
						yield* restored.rows(Schema.Struct({ id: Schema.String, title: Schema.String }), {
							text: 'SELECT id::text,title FROM documents',
							params: []
						})
					).toEqual([{ id: ID, title: 'Earlier' }]);
					expect(
						yield* restored.value(Schema.NullOr(Schema.String), {
							text: "SELECT to_regclass('articles')::text",
							params: []
						})
					).toBeNull();
				})
			).pipe(Effect.provide(Pristine.layer))
	);

	it.live(
		'records the effective currency and refuses to reinterpret old money after a currency migration',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const db = PgliteDb.make(yield* PgliteDb.open());
					const old: EngineManifest = {
						...before,
						workspace: { ...before.workspace, currency: 'USD' },
						models: {
							items: {
								description: 'Item',
								record_label: 'record.title',
								fields: { title: { kind: 'text' }, price: { kind: 'money' } }
							}
						},
						exposures: { items: { outputs: { default: { items: { fields: 'all' } } } } }
					};
					const current: EngineManifest = {
						...old,
						workspace: { ...old.workspace, currency: 'SGD' }
					};
					const initial = schema_slice(old);
					yield* TestDb.migrate(db, initial);
					yield* db.write({
						text: "insert into items(id,title,price) values($1,'Money',12.50)",
						params: [ID]
					});
					yield* TestDb.migrate(db, current);
					const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(
						yield* read_history(
							db,
							current,
							{
								kind: 'history',
								model: 'items',
								id: ID,
								view: true,
								at: { _tag: 'Revision', revision: 1 }
							},
							{ as: 'caller', authority: admin },
							bindings
						)
					);
					expect(snapshot.fields.price).toMatchObject({ kind: 'money', currency: 'USD' });
					expect(snapshot.incompatible).toContain('price');
					expect(snapshot.compatible).not.toHaveProperty('price');
				})
			).pipe(Effect.provide(Pristine.layer))
	);
	it.live('refuses missing, unknown, retired-flag and incomplete history metadata without rewriting it', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = PgliteDb.make(yield* PgliteDb.open());
				yield* TestDb.migrate(db, before);
				yield* db.write({
					text: "insert into documents(id,title) values($1,'Original')",
					params: [ID]
				});
				const metadata = () => db.value(Schema.JsonObject, {
					text: 'select meta from bolt_history where record=$1 and revision=1', params: [ID]
				});
				const version = yield* db.value(Schema.String, {
					text: "select schema::text from bolt_history_current where model='documents'", params: []
				});
				const field_ids = () => db.value(Schema.JsonObject, {
					text: 'select fields from bolt_history_schema where id=$1', params: [version]
				});
				const original_meta = yield* metadata(), original_fields = yield* field_ids();
				for (const [index, corruption] of [
					{ text: "update bolt_history set meta=meta-'schema' where record=$1", params: [ID] },
					{ text: "update bolt_history set meta=jsonb_set(meta,'{schema}',to_jsonb(gen_random_uuid()::text)) where record=$1", params: [ID] },
					{ text: "update bolt_history set meta=meta||'{\"legacy\":true}'::jsonb where record=$1", params: [ID] },
					{ text: "update bolt_history_schema set fields=fields-'title' where id=$1", params: [version] }
				].entries()) {
					yield* db.write(corruption);
					const stored_meta = yield* metadata(), stored_fields = yield* field_ids();
					// Re-registering the same definition must neither stamp history nor invent missing field identities.
					yield* db.write({
						text: 'select bolt_history_register(model,definition) from bolt_history_schema where id=$1', params: [version]
					});
					expect(yield* Effect.flip(read_history(db, before, {
						kind: 'history', model: 'documents', id: ID, view: true, at: { _tag: 'Revision', revision: 1 }
					}, { as: 'caller', authority: admin }, bindings))).toMatchObject({ code: 'schema' });
					if (index < 2)
						expect(yield* Effect.flip(prune_history(db, 1))).toMatchObject({ sqlstate: 'BA001' });
					expect(yield* metadata()).toEqual(stored_meta);
					expect(yield* field_ids()).toEqual(stored_fields);
					expect(yield* db.value(Schema.String, { text: 'select title from documents where id=$1', params: [ID] })).toBe('Original');
					yield* db.write({ text: 'update bolt_history set meta=$2::jsonb where record=$1', params: [ID, original_meta] });
					yield* db.write({ text: 'update bolt_history_schema set fields=$2::jsonb where id=$1', params: [version, original_fields] });
				}
			})
		).pipe(Effect.provide(Pristine.layer))
	);
	it.live('keeps unsupported versioned descriptors raw without normalizing retired reference or state metadata', () =>
		Effect.scoped(Effect.gen(function* () {
			const db = PgliteDb.make(yield* PgliteDb.open());
			yield* TestDb.migrate(db, before);
			yield* db.write({ text: "insert into documents(id,title) values($1,'Archived raw value')", params: [ID] });
			const version = yield* db.value(Schema.String, {
				text: "select meta->>'schema' from bolt_history where record=$1 and revision=1", params: [ID]
			});
			// Only the historical descriptor becomes unknown; its actual registered field identity is retained.
			yield* db.write({
				text: "update bolt_history_schema set definition=jsonb_set(definition,'{fields,title}','{\"kind\":\"archived_custom_kind\",\"original\":[true,1,\"raw\"]}'::jsonb) where id=$1",
				params: [version]
			});
			yield* TestDb.migrate(db, after, { accept: true });
			// a later write makes revision 1 a past revision a restore may preview
			yield* db.write({ text: "update articles set secret='later' where id=$1", params: [ID] });
			for (const descriptor of [
				{ kind: 'archived_custom_kind', original: [true, 1, 'raw'] },
				{ kind: 'ref', to: 'documents', onDelete: 'cascade' },
				{ kind: 'ref', to: 'documents', optional: true, on_delete: 'setNull' },
				{ kind: 'ref', to: 'documents', on_delete: 'cascade', onDelete: 'cascade' },
				{ kind: 'state', initial: 'open', states: { open: { edit: 'none' } } },
				{ kind: 'object', fields: { status: { kind: 'state', initial: 'open', states: { open: { edit: 'none' } } } } }
			]) {
				yield* db.write({
					text: "update bolt_history_schema set definition=jsonb_set(definition,'{fields,title}',$2::jsonb) where id=$1",
					params: [version, JSON.stringify(descriptor)]
				});
				const archived = yield* db.rows(Schema.Struct({ definition: Schema.JsonObject, fields: Schema.JsonObject }), {
					text: 'select definition,fields from bolt_history_schema where id=$1', params: [version]
				});
				const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(yield* read_history(db, after, {
					kind: 'history', model: 'articles', id: ID, view: true, at: { _tag: 'Revision', revision: 1 }
				}, { as: 'caller', authority: admin }, bindings));
				expect(snapshot.schema_version).toBe(version);
				expect(snapshot.values.title).toBe('Archived raw value');
				expect(snapshot.fields).not.toHaveProperty('title');
				expect(snapshot.incompatible).toContain('title');
				expect(snapshot.compatible).not.toHaveProperty('heading');
				const preview = yield* restorePreview({ manifest: after, db }, { model: 'articles', record: ID, revision: 1 }, admin, bindings);
				if (!preview.ok) throw new Error(preview.outcome.message);
				expect(preview.preview.changes).not.toContainEqual(expect.objectContaining({ field: 'heading' }));
				expect(preview.preview.skipped).toContainEqual(expect.objectContaining({ field: 'title', reason: 'incompatible' }));
				expect(yield* db.rows(Schema.Struct({ definition: Schema.JsonObject, fields: Schema.JsonObject }), {
					text: 'select definition,fields from bolt_history_schema where id=$1', params: [version]
				})).toEqual(archived);
			}
			const [native] = yield* db.rows(HistorySchema, {
				text: "select s.id::text,s.lineage::text,s.model,s.definition,s.fields from bolt_history_schema s join bolt_history_current c on c.schema=s.id where c.model='sys_conversation' and c.active",
				params: []
			});
			if (native === undefined) throw new Error('The current native conversation schema was not registered.');
			const original_definition = JSON.stringify(native.definition);
			expect(native.definition.fields.integration).toMatchObject({ kind: 'ref', on_delete: 'cascade' });
			const current_reference = historyKinds(native).integration;
			expect(current_reference).toMatchObject({ kind: 'ref', to: 'sys_integration', optional: true });
			expect(current_reference).not.toHaveProperty('on_delete');
			expect(JSON.stringify(native.definition)).toBe(original_definition);
		})).pipe(Effect.provide(Pristine.layer))
	);
	it.live('versions native identity history and rolls back a mutation without its registered schema', () =>
		Effect.scoped(Effect.gen(function* () {
			const db = PgliteDb.make(yield* PgliteDb.open());
			const native: EngineManifest = { ...before, models: {}, relationships: {}, exposures: {} };
			yield* TestDb.migrate(db, native);
			const create = new IdentityStatement();
			identityPiece(create, 'member', 'sys_user', `insert into sys_user(id,name) values(${create.p(ID)},'Native member')`);
			identityHistory(create, 'sys_user', 'member', new Date(NOW), 'host');
			yield* db.write(create.sql('1 AS applied'));
			const version = yield* db.value(Schema.String, {
				text: "select schema::text from bolt_history_current where model='sys_user' and active", params: []
			});
			const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(yield* read_history(db, native, {
				kind: 'history', model: 'sys_user', id: ID, view: true
			}, { as: 'workspace' }, bindings));
			expect(snapshot.schema_version).toBe(version);
			expect(snapshot.values.name).toBe('Native member');
			expect(snapshot.compatible.name).toBe('Native member');
			yield* db.write({ text: "update bolt_history_current set active=false where model='sys_user'", params: [] });
			const change = new IdentityStatement();
			identityPiece(change, 'member', 'sys_user', `update sys_user set name='Uncommitted',revision=revision+1 where id=${change.p(ID)}`);
			identityHistory(change, 'sys_user', 'member', new Date(NOW), 'host');
			expect(yield* Effect.flip(db.write(change.sql('1 AS applied')))).toMatchObject({ sqlstate: 'BA001' });
			expect(yield* db.value(Schema.String, { text: 'select name from sys_user where id=$1', params: [ID] })).toBe('Native member');
			expect(yield* db.value(Schema.Int, { text: 'select count(*)::int from bolt_history where record=$1', params: [ID] })).toBe(1);
		})).pipe(Effect.provide(Pristine.layer))
	);
	it.live('rolls back a schema change while an affected erasure is pending', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = PgliteDb.make(yield* PgliteDb.open());
				const initial = schema_slice(before);
				yield* TestDb.migrate(db, initial);
				yield* db.write({
					text: "insert into documents(id,title) values($1,'Kept')",
					params: [ID]
				});
				yield* db.write({
					text: "insert into bolt_audit_receipt(operation,at,expires_at) values('pending-schema',now(),now()+interval '30 days')",
					params: []
				});
				yield* db.write({
					text: "insert into bolt_audit_erase(operation,collection,record,revision,mode,purge,keep_marker) values('pending-schema','documents',$1,1,'anonymise',array['title'],true)",
					params: [ID]
				});
				const failure = yield* Effect.flip(TestDb.migrate(db, after, { accept: true }));
				expect(failure.message).toContain('pending erasure');
				expect(
					yield* db.value(Schema.String, {
						text: 'select title from documents where id=$1',
						params: [ID]
					})
				).toBe('Kept');
				expect(
					yield* db.value(Schema.Int, {
						text: "select count(*)::int from bolt_history_current where model='articles'",
						params: []
					})
				).toBe(0);
			})
		).pipe(Effect.provide(Pristine.layer))
	);
	it.live('preserves exact decimals, points and periods when restoring an old schema', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = PgliteDb.make(yield* PgliteDb.open());
				const old: EngineManifest = {
					...before,
					models: {
						items: {
							description: 'Item',
							record_label: 'record.title',
							fields: {
								title: { kind: 'text' },
								amount: { kind: 'decimal', scale: 4 },
								location: { kind: 'point' },
								span: { kind: 'period', of: 'date' }
							}
						}
					},
					exposures: {
						items: {
							outputs: { default: { items: { fields: 'all' } } },
							update: { columns: { items: ['title', 'amount', 'location', 'span'] } }
						}
					}
				};
				const initial = schema_slice(old);
				yield* TestDb.migrate(db, initial);
				yield* db.write({
					text: "insert into items(id,title,amount,location,span) values($1,'Original',9007199254740993.1234,'(103.8,1.3)','[2026-01-01,2026-01-31]')",
					params: [ID]
				});
				const current: EngineManifest = {
					...old,
					models: {
						items: {
							description: 'Item',
							record_label: 'record.title',
							fields: {
								title: { kind: 'text' },
								total: { kind: 'decimal', scale: 4, was: 'amount' },
								location: { kind: 'point' },
								span: { kind: 'period', of: 'date' }
							}
						}
					},
					exposures: {
						items: {
							outputs: { default: { items: { fields: 'all' } } },
							update: { columns: { items: ['title', 'total', 'location', 'span'] } }
						}
					}
				};
				yield* TestDb.migrate(db, current);
				yield* db.write({
					text: "update items set total=1.5000,location='(100,2)',span='[2026-02-01,)' where id=$1",
					params: [ID]
				});
				const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(
					yield* read_history(
						db,
						current,
						{
							kind: 'history',
							model: 'items',
							id: ID,
							view: true,
							at: { _tag: 'Revision', revision: 1 }
						},
						{ as: 'caller', authority: admin },
						bindings
					)
				);
				expect(snapshot.values).toMatchObject({
					amount: '9007199254740993.1234',
					location: { lng: 103.8, lat: 1.3 },
					span: { from: '2026-01-01', to: '2026-01-31' }
				});
				expect(snapshot.incompatible).toEqual([]);
				const restored = yield* restoreRecord(
					{ manifest: current, db },
					(request) => act({ manifest: current, db }, request),
					{ model: 'items', record: ID, revision: 1 },
					{
						authority: admin,
						bindings,
						key: 'restore-scalars',
						issuedAt: NOW,
						invocationId: 'restore-scalars'
					}
				);
				expect(restored.outcome.kind).toBe('committed');
				expect(
					yield* db.value(Schema.String, {
						text: 'select total::text from items where id=$1',
						params: [ID]
					})
				).toBe('9007199254740993.1234');
			})
		).pipe(Effect.provide(Pristine.layer))
	);
	it.live('prunes across renamed models and keeps a restorable schema snapshot', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = PgliteDb.make(yield* PgliteDb.open());
				const initial = schema_slice(before);
				yield* TestDb.migrate(db, initial);
				yield* db.write({
					text: "insert into documents(id,title,quantity) values($1,'Original','42')",
					params: [ID]
				});
				yield* db.write({
					text: "update documents set title='Before rename' where id=$1",
					params: [ID]
				});
				yield* TestDb.migrate(db, after, { accept: true });
				yield* db.write({
					text: "update articles set heading='New schema',quantity=7 where id=$1",
					params: [ID]
				});
				yield* db.write({ text: "update articles set heading='Latest' where id=$1", params: [ID] });
				expect(yield* prune_history(db, 2)).toBe(2);
				const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(
					yield* read_history(
						db,
						after,
						{
							kind: 'history',
							model: 'articles',
							id: ID,
							at: { _tag: 'Revision', revision: 3 },
							view: true
						},
						{ as: 'caller', authority: admin },
						bindings
					)
				);
				expect(snapshot.values).toMatchObject({ heading: 'New schema', quantity: 7 });
				expect(snapshot.values).not.toHaveProperty('title');
				expect(snapshot.compatible.quantity).toBe(7);
				const preview = yield* restorePreview(
					{ manifest: after, db },
					{ model: 'articles', record: ID, revision: 3 },
					admin,
					bindings
				);
				if (!preview.ok) throw new Error(preview.outcome.message);
				expect(preview.preview.changes).toContainEqual(
					expect.objectContaining({ field: 'heading', restored: 'New schema' })
				);
			})
		).pipe(Effect.provide(Pristine.layer))
	);
	it.live('erases renamed fields from both readable history and retained audit payloads', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = PgliteDb.make(yield* PgliteDb.open());
				const initial = schema_slice(before);
				yield* TestDb.migrate(db, initial);
				yield* db.write({
					text: "insert into documents(id,title,quantity) values($1,'Sensitive title','42')",
					params: [ID]
				});
				yield* TestDb.migrate(db, after, { accept: true });
				yield* db.write({
					text: "update articles set heading='Redacted' where id=$1",
					params: [ID]
				});
				yield* db.write({
					text: "insert into bolt_audit_receipt(operation,at,expires_at) values('erase-schema',now(),now()+interval '30 days')",
					params: []
				});
				yield* db.write({
					text: "insert into bolt_audit_erase(operation,collection,record,revision,mode,purge,keep_marker) values('erase-schema','articles',$1,2,'anonymise',array['heading'],true)",
					params: [ID]
				});
				const read = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(
					yield* read_history(
						db,
						after,
						{
							kind: 'history',
							model: 'articles',
							id: ID,
							at: { _tag: 'Revision', revision: 1 },
							view: true
						},
						{ as: 'caller', authority: admin },
						bindings
					)
				);
				expect(read.values).not.toHaveProperty('title');
				yield* acknowledgeAudit(db, 'erase-schema');
				yield* drainAuditErases(db);
				expect(
					yield* db.value(Schema.Int, {
						text: "select count(*)::int from bolt_history where changes ? 'title'",
						params: []
					})
				).toBe(0);
			})
		).pipe(Effect.provide(Pristine.layer))
	);
	it.live('keeps historical fields outside a named output and hidden fields private', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = PgliteDb.make(yield* PgliteDb.open());
				const initial = schema_slice(before);
				yield* TestDb.migrate(db, initial);
				yield* db.write({
					text: "insert into documents(id,title,quantity,removed,secret) values($1,'Original','42','Retired private','Secret')",
					params: [ID]
				});
				const narrow: EngineManifest = {
					...after,
					policies: {
						reader: {
							description: '',
							grants: { articles: { outputs: { summary: { history: true } } } }
						}
					},
					exposures: {
						articles: {
							...after.exposures.articles,
							outputs: {
								default: { articles: { fields: ['heading'] } },
								summary: { articles: { fields: ['heading'] } }
							}
						}
					}
				};
				yield* TestDb.migrate(db, narrow, { accept: true });
				// History is granted through the narrow output.
				const caller = yield* compile_authority(
					narrow,
					{ actor: member, admin: false, policies: ['reader'] },
					'history-reader'
				);
				const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(
					yield* read_history(
						db,
						narrow,
						{
							kind: 'history',
							model: 'articles',
							id: ID,
							at: { _tag: 'Revision', revision: 1 },
							view: true,
							output: 'summary'
						},
						{ as: 'caller', authority: caller },
						bindings
					)
				);
				expect(snapshot.values.title).toBe('Original');
				for (const field of ['quantity', 'removed', 'secret']) {
					expect(snapshot.values).not.toHaveProperty(field);
					expect(snapshot.fields).not.toHaveProperty(field);
					expect(snapshot.incompatible).not.toContain(field);
				}
			})
		).pipe(Effect.provide(Pristine.layer))
	);
	it.live('registers a fresh definition parameter without confusing the schema table column', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = PgliteDb.make(yield* PgliteDb.open());
				const initial = schema_slice(before);
				yield* TestDb.migrate(db, initial);
				const table = initial.tables.documents;
				if (table === undefined) throw new Error('The native schema did not define documents.');
				const definition = JSON.stringify(table);
				const register = () =>
					db
						.returning(Schema.Struct({ version: Schema.String }), {
							text: 'select bolt_history_register($1,$2::jsonb) as version',
							params: ['documents', definition]
						})
						.pipe(Effect.map((rows) => rows[0]?.version));
				const first = yield* register();
				expect(first).toBeTypeOf('string');
				expect(yield* register()).toBe(first);
				expect(
					yield* db.value(Schema.Int, {
						text: 'select count(*)::int from bolt_history_schema where model=$1 and definition=$2::jsonb',
						params: ['documents', definition]
					})
				).toBe(1);
			})
		).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'shows original fields after model/field renames and restores compatible values as a new revision',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const db = PgliteDb.make(yield* PgliteDb.open());
					yield* TestDb.migrate(db, before);
					yield* db.write({
						text: 'insert into documents(id,title,quantity,removed,secret) values($1,$2,$3,$4,$5)',
						params: [ID, 'Original', '42', 'Retired value', 'Private']
					});
					yield* db.write({ text: "update documents set title='Later' where id=$1", params: [ID] });
					const original = yield* db.rows(
						Schema.Struct({ changes: Schema.Json, version: Schema.String }),
						{
							text: "select changes,meta->>'schema' as version from bolt_history where collection='documents' order by revision",
							params: []
						}
					);
					yield* TestDb.migrate(db, after, {
						accept: true
					});
					const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(
						yield* read_history(
							db,
							after,
							{
								kind: 'history',
								model: 'articles',
								id: ID,
								at: { _tag: 'Revision', revision: 1 },
								view: true
							},
							{ as: 'caller', authority: admin },
							bindings
						)
					);
					expect(snapshot.values).toMatchObject({
						title: 'Original',
						quantity: '42',
						removed: 'Retired value'
					});
					expect(snapshot.fields.title).toMatchObject({ kind: 'text' });
					expect(snapshot.compatible).toMatchObject({ heading: 'Original', quantity: 42 });
					expect(snapshot.incompatible).toContain('removed');
					const preview = yield* restorePreview(
						{ manifest: after, db },
						{ model: 'articles', record: ID, revision: 1 },
						admin,
						bindings
					);
					if (!preview.ok) throw new Error(preview.outcome.message);
					expect(preview.preview.changes).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ field: 'heading', restored: 'Original' }),
							expect.objectContaining({ field: 'quantity', restored: 42 })
						])
					);
					expect(preview.preview.skipped).toContainEqual(
						expect.objectContaining({ field: 'removed', reason: 'incompatible' })
					);
					const restored = yield* restoreRecord(
						{ manifest: after, db },
						(request) => act({ manifest: after, db }, request),
						{ model: 'articles', record: ID, revision: 1 },
						{
							authority: admin,
							bindings,
							key: 'restore-versioned',
							issuedAt: NOW,
							invocationId: 'restore-versioned'
						}
					);
					expect(restored.outcome.kind).toBe('committed');
					expect(
						yield* db.rows(Schema.Struct({ heading: Schema.String, quantity: Schema.Int }), {
							text: 'select heading,quantity from articles where id=$1',
							params: [ID]
						})
					).toEqual([{ heading: 'Original', quantity: 42 }]);
					expect(
						yield* db.rows(Schema.Struct({ changes: Schema.Json, version: Schema.String }), {
							text: "select changes,meta->>'schema' as version from bolt_history where collection='documents' order by revision",
							params: []
						})
					).toEqual(original);
				})
			).pipe(Effect.provide(Pristine.layer))
	);
	it.live('marks unconvertible values and a dropped/re-added field incompatible', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = PgliteDb.make(yield* PgliteDb.open());
				yield* TestDb.migrate(db, before);
				yield* db.write({
					text: 'insert into documents(id,title,quantity,removed) values($1,$2,$3,$4)',
					params: [ID, 'Original', 'not a number', 'Old meaning']
				});
				yield* TestDb.migrate(db, after, {
					accept: true
				});
				const readded: EngineManifest = {
					...after,
					models: {
						articles: {
							...after.models.articles,
							description: 'Articles',
							fields: {
								...after.models.articles?.fields,
								removed: { kind: 'text', optional: true }
							}
						}
					}
				};
				yield* TestDb.migrate(db, readded);
				const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(
					yield* read_history(
						db,
						readded,
						{ kind: 'history', model: 'articles', id: ID, view: true },
						{ as: 'caller', authority: admin },
						bindings
					)
				);
				expect(snapshot.incompatible).toEqual(expect.arrayContaining(['quantity', 'removed']));
				expect(snapshot.compatible).not.toHaveProperty('removed');
				expect(snapshot.compatible).not.toHaveProperty('quantity');
				expect(snapshot.values.removed).toBe('Old meaning');
				const listed = yield* Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({
							valid: Schema.Boolean,
							incompatible: Schema.Array(Schema.String)
						})
					)
				)(
					yield* read_history(
						db,
						readded,
						{ kind: 'history', model: 'articles', id: ID },
						{ as: 'caller', authority: admin },
						bindings
					)
				);
				expect(listed.at(-1)).toMatchObject({
					valid: false,
					incompatible: expect.arrayContaining(['quantity', 'removed'])
				});
			})
		).pipe(Effect.provide(Pristine.layer))
	);
});
