import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { RunHandlers } from '../src/engine/services.ts';
import { Files } from '../src/engine/ports.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest as base } from './write-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const alice = '0199a000-0000-7000-8000-000000000001',
	bob = '0199a000-0000-7000-8000-000000000002',
	own = '0199a000-0000-7000-8000-000000000011',
	other = '0199a000-0000-7000-8000-000000000012';
const manifest: EngineManifest = {
	...base,
	messages: {
		'models.documents.fields.secret': 'Document secret',
		'models.documents.syncs.sheet.schema.fields.secret': 'Private content'
	},
	models: {
		documents: {
			description: 'Documents',
			record_label: 'record.secret',
			fields: { owner: { kind: 'text' }, secret: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		documents: {
			outputs: { default: { documents: { fields: 'all' } } },
			syncs: {
				sheet: {
					with: 'file',
					parser: ['csv'],
					schema: { secret: { kind: 'text' } },
					context: { document: { kind: 'ref', to: 'documents' } },
					write: true
				}
			}
		}
	},
	policies: {
		sales: {
			description: 'Own documents',
			grants: {
				documents: {
					outputs: {
						default: { scopes: { documents: { owner: { eq: { var: 'requestor.id' } } } } }
					}
				}
			}
		}
	},
	teams: { sales: { policies: ['sales'] } }
};
it.live(
	'file exports preserve caller row scopes, including a read request fed by arbitrary context',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest,
						guest: yield* program(
							`export default {
	model: {
		documents: {
			bodies: {
				syncs: {
					sheet: {
						write: function*({ context }, ctx) {
							const { documents } = yield* ctx.query({
								documents: { where: { id: { eq: context.document } }, fields: ['secret'] }
							});
							return [{ secret: documents.rows[0]?.secret ?? 'missing' }];
						}
					}
				}
			}
		}
	}
};`
						)
					})
				);
				const t = Context.get(context, TestWorkspace),
					registry = Context.get(context, RunHandlers);
				yield* t.db.write({
					text: "INSERT INTO sys_user(id,name,kind,team) VALUES ($1,'Alice','staff','sales'),($2,'Bob','staff','sales')",
					params: [alice, bob]
				});
				yield* t.db.write({
					text: 'INSERT INTO documents(id,owner,secret) VALUES ($1::uuid,$2,$3),($4::uuid,$5,$6)',
					params: [own, alice, 'Alice secret', other, bob, 'Bob secret']
				});
				const handler = yield* registry.handler('documents.sync.sheet');
				if (Option.isNone(handler)) throw new Error('Missing file sync');
				const starter = {
					actor: {
						kind: 'member' as const,
						id: alice,
						email: null,
						phone: null,
						external: false,
						teams: ['sales'],
						team_path: ['sales'],
						admin: false,
						party: null
					},
					policies: ['sales'],
					admin: false
				};
				const exported = (document: string) =>
					Effect.gen(function* () {
						const out = yield* Schema.decodeUnknownEffect(
							Schema.Struct({ file: Schema.Struct({ id: Schema.String, name: Schema.String }) })
						)(
							yield* handler.value(
								{ mode: 'export', to: 'csv', context: { document } },
								{ id: randomUUID(), starter }
							)
						);
						expect(out.file.name).toContain('.csv');
						const key = yield* t.db.value(Schema.String, {
							text: 'SELECT key FROM sys_file WHERE id = $1',
							params: [out.file.id]
						});
						return new TextDecoder().decode(t.fakes.files.blobs.get(key));
					});
				// the context names Bob's document: the body's read runs as Alice and reaches nothing
				const denied = yield* exported(other);
				expect(denied).toContain('missing');
				expect(denied).not.toContain('Bob secret');
				const allowed = yield* exported(own);
				expect(allowed.split(/\r?\n/)[0]).toBe('Private content');
				expect(allowed).toContain('Alice secret');
				expect(allowed).not.toContain('Bob secret');
			})
		)
);

it.live('file captions round trip through exports and imports, with schema captions scoped to their sync', () =>
	Effect.scoped(Effect.gen(function* () {
		const captions: EngineManifest = {
			...base,
			workspace: { tz: 'UTC', locale: 'fr' },
			messages: {
				'models.documents.fields.code': 'Code du modèle',
				'models.documents.fields.display_name': 'Nom',
				'models.documents.syncs.sheet.schema.fields.code': 'Référence'
			},
			models: { documents: {
				description: 'Documents', record_label: 'record.display_name', key: ['code'],
				unique: [{ fields: ['code'], import_key: true }],
				fields: {
					code: { kind: 'text' }, display_name: { kind: 'text' },
					internal_note: { kind: 'text', optional: true }
				}
			} },
			relationships: {},
			exposures: { documents: {
				outputs: { default: { documents: { fields: 'all' } } },
				create: { columns: { documents: ['code', 'display_name', 'internal_note'] } },
				update: { columns: { documents: ['code', 'display_name', 'internal_note'] } },
				syncs: {
					sheet: { with: 'file', parser: ['csv'], schema: {
						code: { kind: 'text' }, display_name: { kind: 'text' },
						internal_note: { kind: 'text', optional: true }
					} },
					plain: { with: 'file', parser: ['csv'] }
				}
			} }
		};
		const context = yield* Layer.build(TestWorkspace.layer({ manifest: captions }));
		const t = Context.get(context, TestWorkspace),
			registry = Context.get(context, RunHandlers),
			files = Context.get(context, Files);
		yield* t.db.write({
			text: "INSERT INTO sys_user(id,name,kind,admin) VALUES ($1,'Alice','staff',true)",
			params: [alice]
		});
		yield* t.db.write({
			text: 'INSERT INTO documents(id,code,display_name) VALUES ($1::uuid,$2,$3)',
			params: [own, 'A', 'Original']
		});
		const starter = { actor: {
			kind: 'member' as const, id: alice, email: null, phone: null, external: false,
			teams: [], team_path: [], admin: true, party: null
		}, policies: [], admin: true };
		const exported = Effect.fnUntraced(function* (sync: string) {
			const handler = yield* registry.handler(`documents.sync.${sync}`);
			if (Option.isNone(handler)) throw new Error('Missing file sync');
			const out = yield* Schema.decodeUnknownEffect(Schema.Struct({
				file: Schema.Struct({ id: Schema.String })
			}))(yield* handler.value({ mode: 'export', format: 'csv' }, { id: randomUUID(), starter }));
			const key = yield* t.db.value(Schema.String, {
				text: 'SELECT key FROM sys_file WHERE id = $1', params: [out.file.id]
			});
			const bytes = yield* files.get(key, 1_000_000);
			return new TextDecoder().decode(bytes);
		});
		const sheet = yield* exported('sheet');
		expect(sheet.split(/\r?\n/)[0]).toBe('Référence,Nom,internal_note');
		const handler = yield* registry.handler('documents.sync.sheet');
		if (Option.isNone(handler)) throw new Error('Missing file sync');
		for (const { csv, expected } of [
			{ csv: sheet.replace('Original', 'From caption'), expected: 'From caption' },
			{ csv: 'code,display_name\nA,From name\n', expected: 'From name' }
		]) {
			const bytes = new TextEncoder().encode(csv), id = randomUUID();
			const blob = yield* files.put(bytes, { name: 'rows.csv', mime: 'text/csv' });
			yield* t.db.write({
				text: `INSERT INTO sys_file(id,name,mime,size,key,sha256,field,created_by,created_at)
					VALUES ($1,'rows.csv','text/csv',$2,$3,$4,'documents.$import.sheet',$5,now())`,
				params: [id, bytes.byteLength, blob.key, blob.sha256, alice]
			});
			expect(yield* handler.value({ mode: 'import', file: id }, { id: randomUUID(), starter }))
				.toMatchObject({ applied: true, findings: [] });
			expect(yield* t.db.value(Schema.String, {
				text: 'SELECT display_name FROM documents WHERE code = $1', params: ['A']
			})).toBe(expected);
		}
		expect((yield* exported('plain')).split(/\r?\n/)[0]).toBe('Code du modèle,Nom,internal_note');
	}))
);

it.live('a member exports, downloads a template and imports through the sync_control route', () =>
	Effect.scoped(Effect.gen(function* () {
		const sheets: EngineManifest = {
			...base,
			models: { orders: {
				description: 'Orders', record_label: 'record.customer',
				unique: [{ fields: ['customer'], import_key: true }],
				fields: { customer: { kind: 'text' }, note: { kind: 'text', optional: true } }
			} },
			relationships: {},
			exposures: { orders: {
				outputs: { default: { orders: { fields: 'all' } } },
				create: { columns: { orders: ['customer', 'note'] } },
				update: { columns: { orders: ['customer', 'note'] } },
				syncs: { sheet: { with: 'file', parser: ['csv'], schema: {
					customer: { kind: 'text' }, note: { kind: 'text', optional: true }
				} } }
			} }
		};
		const t = Context.get(yield* Layer.build(TestWorkspace.layer({ manifest: sheets })), TestWorkspace);
		const member = yield* t.as(t.admin);
		const ran = Effect.fnUntraced(function* (input: Parameters<typeof member.sync_control<'orders', 'sheet'>>[2]) {
			const started = yield* member.sync_control('orders', 'sheet', input);
			if (started.kind !== 'committed') throw new Error('start held');
			yield* t.run_due();
			return yield* t.db.value(Schema.Unknown, {
				text: 'SELECT output FROM sys_run WHERE id = $1', params: [started.output.id]
			});
		});
		const csv = Effect.fnUntraced(function* (output: unknown) {
			const { file } = yield* Schema.decodeUnknownEffect(Schema.Struct({ file: Schema.Struct({ id: Schema.String }) }))(output);
			const key = yield* t.db.value(Schema.String, { text: 'SELECT key FROM sys_file WHERE id = $1', params: [file.id] });
			return new TextDecoder().decode(t.fakes.files.blobs.get(key));
		});
		expect((yield* csv(yield* ran({ mode: 'template', format: 'csv' }))).split(/\r?\n/)[0]).toBe('customer,note');
		const uploaded = yield* member.upload('orders.$import.sheet', {
			name: 'rows.csv', mime: 'text/csv', bytes: new TextEncoder().encode('customer,note\nAcme,Imported\n')
		});
		if (uploaded.kind !== 'committed') throw new Error('upload held');
		expect(yield* ran({ mode: 'import', file: uploaded.output.id })).toMatchObject({ applied: true, findings: [] });
		expect(yield* csv(yield* ran({ mode: 'export', format: 'csv' }))).toContain('Acme,Imported');
	}))
);
