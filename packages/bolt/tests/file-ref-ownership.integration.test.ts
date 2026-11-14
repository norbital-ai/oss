// A file ref a person writes into a file field, or starts an automation with, is their own unbound upload for that
// field or automation, or a file they already read: a copied id never reaches another member's file, and an upload
// bound to a row its uploader no longer reads is not re-bound elsewhere.
import { Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { JobResult, TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

const file = { kind: 'file', accept: ['*/*'], max: '1MiB' } as const;
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		docs: {
			description: 'A document',
			record_label: 'record.title',
			fields: { title: { kind: 'text' }, file: { ...file, optional: true } }
		}
	},
	relationships: {},
	exposures: {
		docs: {
			outputs: { default: { docs: { fields: 'all' } } },
			create: { columns: { docs: ['title', 'file'] } },
			update: { columns: { docs: ['file'] } }
		}
	},
	policies: {
		own: {
			description: 'Own documents',
			grants: {
				docs: {
					outputs: { default: { scopes: { docs: { created_by: { eq: { var: 'actor.id' } } } } } },
					create: {},
					update: {}
				}
			},
			capabilities: { automations: ['ingest'] }
		}
	},
	automations: {
		ingest: {
			description: 'Reads the given file',
			input: { file },
			policies: ['own']
		}
	},
	integrations: {},
	teams: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const guestSource = `export default { automation: { ingest: { body: function* (input, ctx) { yield* ctx.files.get(input.file); } } } };`;
const pdf = (name: string) => ({ name, mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) });
// the fixture's names are not in the type registry
const docsCreate: string = 'docs.create',
	docsUpdate: string = 'docs.update',
	ingest: string = 'ingest';

describe('a written file ref', () => {
	it.live('is the writer’s own unbound upload or a file they read', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const t = Context.get(
					yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* program(guestSource) })),
					TestWorkspace
				);
				const ann = yield* t.as(t.member(['own'])),
					bob = yield* t.as(t.member(['own'])),
					admin = yield* t.as(t.admin);
				const upload = (who: typeof ann, field: `${string}.${string}`, name: string) =>
					who.upload(field, pdf(name)).pipe(
						Effect.flatMap((answer) => (answer.kind === 'committed' ? Effect.succeed(answer.output) : Effect.die(answer)))
					);
				// Ann files her upload in her own document; Bob reads none of her rows
				const anns = yield* upload(ann, 'docs.file', 'ann.pdf');
				yield* ann.act({ [docsCreate]: [{ title: 'Ann', file: anns }] });
				expect(yield* Effect.flip(bob.act({ [docsCreate]: [{ title: 'Copied', file: anns }] }))).toMatchObject({
					code: 'not_found'
				});
				// his own upload, not yet held by any row, files once
				const bobs = yield* upload(bob, 'docs.file', 'bob.pdf');
				expect((yield* bob.act({ [docsCreate]: [{ title: 'Bob', file: bobs }] })).kind).toBe('committed');
				// re-bound: his upload filed by the administrator in a row he cannot read is no longer his to file
				const held = yield* upload(bob, 'docs.file', 'held.pdf');
				yield* admin.act({ [docsCreate]: [{ title: 'Admin', file: held }] });
				expect(yield* Effect.flip(bob.act({ [docsCreate]: [{ title: 'Again', file: held }] }))).toMatchObject({
					code: 'not_found'
				});
				// an update that keeps a ref the row already holds is no new ref
				const bobsDoc = () =>
					t.db.value(Schema.Struct({ id: Schema.String, revision: Schema.Number }), {
						text: `SELECT json_build_object('id', id::text, 'revision', revision) FROM docs WHERE title = 'Bob'`,
						params: []
					});
				expect((yield* bob.act({ [docsUpdate]: [{ target: yield* bobsDoc(), set: { file: bobs } }] })).kind).toBe('committed');
				expect(yield* Effect.flip(bob.act({ [docsUpdate]: [{ target: yield* bobsDoc(), set: { file: anns } }] }))).toMatchObject({
					code: 'not_found'
				});
				// an automation start's file input: another starter's upload for it is refused, one's own starts
				const input = yield* upload(ann, 'ingest.$input.file', 'input.pdf');
				expect(yield* Effect.flip(bob.run(ingest, { file: input }, JobResult))).toMatchObject({ code: 'not_found' });
				expect((yield* ann.run(ingest, { file: input }, JobResult)).kind).toBe('committed');
			})
		)
	);
});
