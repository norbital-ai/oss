import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { program } from './support/guest-fixture.ts';
import { Context, Effect, Layer, Schema } from 'effect';
// End to end through the engine entry and the test kit: a `created` trigger with a delay is queued by the act's own
// statement, announced to the deadlines port, and runs its body when the deadline wakes (rules 49, 52a).
import { describe, expect, it } from '@effect/vitest';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../src/test/index.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		quotes: {
			description: 'A quote',
			label: 'title',
			fields: {
				title: { kind: 'text' },
				status: { kind: 'enum', values: ['draft', 'sent'], default: 'draft' }
			}
		}
	},
	relationships: {},
	collections: {
		quotes: {
			read: { fields: 'all' },
			create: { input: { columns: ['title'] } },
			update: { input: { columns: ['status'] } }
		}
	},
	policies: {
		ops: { description: 'Ops', grants: { quotes: { read: true, create: true, update: true } } }
	},
	automations: {
		remind: {
			description: 'Send an hour after creation',
			on: { created: 'quotes', delay: '1h' },
			runAs: ['ops']
		}
	},
	integrations: {},
	pipelines: {},
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;
const guestSource = `export default { automation: { remind: { body: function* (input, ctx) {
	for (const id of input.ids) yield* ctx.act('quotes.update', { target: id, set: { status: 'sent' } });
} } } };`;

describe('an automation on created with a delay', () => {
	it.live('fires once through the deadlines port, not before its due time', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest,
						guest: yield* program(guestSource),
						now: '2026-09-25T10:00:00.000Z'
					})
				);
				const t = Context.get(context, TestWorkspace),
					route = yield* routeFixture(context);
				const ops = t.as(t.member(['ops']));
				const created = (yield* actReply(route, ops.authority, {
					callable: 'quotes.create',
					input: { title: 'q1' },
					issuedAt: t.clock.now()
				})).outcome;
				if (created.kind !== 'committed' || created.records[0] === undefined)
					throw new Error('Missing created quote');
				const id = created.records[0].id;
				expect(
					t.fakes.deadlines.announced.map(({ scope, at }) => ({ scope, at: Date.parse(at) }))
				).toContainEqual({
					scope: 'test',
					at: Date.parse('2026-09-25T11:00:00.000Z')
				});
				yield* t.runDue();
				expect(
					yield* Schema.decodeUnknownEffect(
						Schema.NullOr(Schema.Record(Schema.String, Schema.Json))
					)(
						(yield* qReply(route, ops.authority, { reads: [{ m: 'get', a: ['quotes', id] }] }))
							.answers[0]
					)
				).toMatchObject({ status: 'draft' });
				t.clock.advance('1h');
				yield* t.runDue();
				expect(
					yield* Schema.decodeUnknownEffect(
						Schema.NullOr(Schema.Record(Schema.String, Schema.Json))
					)(
						(yield* qReply(route, ops.authority, { reads: [{ m: 'get', a: ['quotes', id] }] }))
							.answers[0]
					)
				).toMatchObject({ status: 'sent' });
				const runs = present(
					(yield* t.db.read([{ text: 'SELECT automation, state FROM sys_run', params: [] }]))[0]
				).rows;
				expect(runs).toEqual([{ automation: 'remind', state: 'succeeded' }]);
			})
		)
	);
});

describe('an automation acting on a failing collection action', () => {
	it.live('fails the run with the action body error, not an unknown outcome', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const quotes = present(manifest.collections.quotes);
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest: {
							...manifest,
							collections: {
								quotes: { ...quotes, actions: { boom: { description: 'Throws', input: {} } } }
							},
							policies: {
								ops: {
									description: 'Ops',
									grants: { quotes: { read: true, create: true, update: true, actions: ['boom'] } }
								}
							},
							automations: {
								remind: {
									description: 'Act on a throwing action',
									on: { created: 'quotes' },
									runAs: ['ops']
								}
							}
						},
						guest: yield* program(`export default {
	automation: { remind: { body: function* (input, ctx) { yield* ctx.act('quotes.boom', {}); } } },
	collection: { quotes: { bodies: { actions: { boom: function* () { throw new Error('a bug'); } } } } },
};`),
						now: '2026-09-25T10:00:00.000Z'
					})
				);
				const t = Context.get(context, TestWorkspace),
					route = yield* routeFixture(context);
				yield* actReply(route, t.as(t.member(['ops'])).authority, {
					callable: 'quotes.create',
					input: { title: 'q1' },
					issuedAt: t.clock.now()
				});
				yield* t.runDue();
				const runs = present(
					(yield* t.db.read([
						{
							text: `SELECT state, error->>'code' AS code, error->>'message' AS message FROM sys_run`,
							params: []
						}
					]))[0]
				).rows;
				expect(runs).toEqual([{ state: 'failed', code: 'guestError', message: 'a bug' }]);
			})
		)
	);
});
