import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { RunHandlers } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest as base } from './write-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const alice = '0199a000-0000-7000-8000-000000000001',
	bob = '0199a000-0000-7000-8000-000000000002',
	own = '0199a000-0000-7000-8000-000000000011',
	other = '0199a000-0000-7000-8000-000000000012';
const manifest: EngineManifest = {
	...base,
	models: {
		documents: {
			description: 'Documents',
			label: 'secret',
			fields: { owner: { kind: 'text' }, secret: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		documents: {
			read: { documents: { fields: 'all' } },
			syncs: {
				sheet: {
					with: 'file',
					parser: ['csv'],
					schema: { secret: { kind: 'text' } },
					context: { document: { kind: 'id', of: 'documents' } },
					write: true
				}
			}
		}
	},
	policies: {
		sales: {
			description: 'Own documents',
			grants: {
				documents: { read: { documents: { where: { owner: { eq: { var: 'requestor.id' } } } } } }
			}
		}
	},
	teams: { sales: ['sales'] }
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
							const { documents } = yield* ctx.db.query({
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
						teamPath: ['sales'],
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
				expect(allowed).toContain('Alice secret');
				expect(allowed).not.toContain('Bob secret');
			})
		)
);
