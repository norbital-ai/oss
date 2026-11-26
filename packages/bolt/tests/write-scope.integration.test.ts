// An update or delete reaches only the rows its granting policy's own `default` scope admits: a wider output the holder
// also reads (a public card) never widens what the write grant targets. An automation's `id` input follows the same scope.
import { Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { JobResult, TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

const mine = { created_by: { eq: { var: 'actor.id' } } };
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		people: {
			description: 'A person',
			record_label: 'record.name',
			fields: { name: { kind: 'text' }, phone: { kind: 'text', optional: true } }
		}
	},
	relationships: {},
	exposures: {
		people: {
			outputs: { default: { people: { fields: 'all' } }, card: { people: { fields: ['name'] } } },
			create: { columns: { people: ['name', 'phone'] } },
			update: { columns: { people: ['phone'] } },
			delete: {}
		}
	},
	policies: {
		staff: {
			description: 'Everyone’s card; one’s own record',
			grants: {
				people: {
					outputs: { default: { scopes: { people: mine } }, card: {} },
					create: {},
					update: { columns: { people: ['phone'] } },
					delete: {}
				}
			},
			capabilities: { automations: ['call'] }
		},
		directory: {
			description: 'Everyone’s card only',
			grants: { people: { outputs: { card: {} } } },
			capabilities: { automations: ['call'] }
		}
	},
	automations: {
		call: {
			description: 'Calls a person',
			input: { person: { kind: 'ref', to: 'people' } },
			policies: ['staff']
		}
	},
	integrations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const guestSource = `export default { automation: { call: { body: function* () {} } } };`;
// the fixture's names are not in the type registry
const create: string = 'people.create',
	update: string = 'people.update',
	remove: string = 'people.delete',
	call: string = 'call';

describe('a write grant’s scope', () => {
	it.live('is its own default output, never a wider readable output', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const t = Context.get(
					yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* program(guestSource) })),
					TestWorkspace
				);
				const ann = yield* t.as(t.member(['staff'])),
					bob = yield* t.as(t.member(['staff'])),
					carol = yield* t.as(t.member(['directory']));
				yield* ann.act({ [create]: [{ name: 'Ann', phone: '1' }] });
				yield* bob.act({ [create]: [{ name: 'Bob', phone: '2' }] });
				const id = (name: string) =>
					t.db.value(Schema.Struct({ id: Schema.String, revision: Schema.Number }), {
						text: 'SELECT json_build_object(\'id\', id::text, \'revision\', revision) FROM people WHERE name = $1',
						params: [name]
					});
				const anns = yield* id('Ann'),
					bobs = yield* id('Bob');
				// Bob reads Ann's card, yet his phone grant reaches only his own record
				expect(yield* Effect.flip(bob.act({ [update]: [{ target: anns, set: { phone: '666' } }] }))).toMatchObject({
					code: 'forbidden'
				});
				expect(yield* Effect.flip(bob.act({ [remove]: [{ target: anns }] }))).toMatchObject({ code: 'forbidden' });
				expect(
					yield* t.db.value(Schema.String, { text: 'SELECT phone FROM people WHERE id = $1', params: [anns.id] })
				).toBe('1');
				expect((yield* bob.act({ [update]: [{ target: bobs, set: { phone: '3' } }] })).kind).toBe('committed');
				// an automation aimed at a record: a starter holding `default` aims only within it, never at one only a card shows
				expect(yield* Effect.flip(bob.run(call, { person: anns.id }, JobResult))).toMatchObject({ code: 'not_found' });
				// a starter with no `default` aims within its own named output, as its policy declares
				expect((yield* carol.run(call, { person: anns.id }, JobResult)).kind).toBe('committed');
				expect((yield* bob.run(call, { person: bobs.id }, JobResult)).kind).toBe('committed');
			})
		)
	);
});
