import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { program } from '../src/test/guest.ts';
import { Context, Effect, Layer, Schema } from 'effect';
// End to end through the engine entry and the test kit: a `created` trigger with a delay is queued by the act's own
// statement, announced to the deadlines port, and runs its body when the deadline wakes (rules 49, 52a).
import { describe, expect, it } from '@effect/vitest';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { uuidv7 } from '../src/protocol/wire.ts';

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
	exposures: {
		quotes: {
			read: { quotes: { fields: 'all' } },
			create: { columns: { quotes: ['title'] } },
			update: { columns: { quotes: ['status'] } }
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
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const guestSource = `export default { automation: { remind: { body: function* (input, ctx) {
	for (const id of input.ids) yield* ctx.act('quotes.update', [{ target: id, set: { status: 'sent' } }]);
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
					input: [{ title: 'q1' }],
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
						Schema.Struct({ quotes: Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }) })
					)(
						(yield* qReply(route, ops.authority, {
							reads: [{ m: 'query', a: [{ quotes: { where: { id: { eq: id } } } }] }]
						})).answers[0]
					).pipe(Effect.map((answer) => answer.quotes.rows[0]))
				).toMatchObject({ status: 'draft' });
				t.clock.advance('1h');
				yield* t.runDue();
				expect(
					yield* Schema.decodeUnknownEffect(
						Schema.Struct({ quotes: Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }) })
					)(
						(yield* qReply(route, ops.authority, {
							reads: [{ m: 'query', a: [{ quotes: { where: { id: { eq: id } } } }] }]
						})).answers[0]
					).pipe(Effect.map((answer) => answer.quotes.rows[0]))
				).toMatchObject({ status: 'sent' });
				const runs = present(
					(yield* t.db.read([{ text: 'SELECT automation, state FROM sys_run', params: [] }]))[0]
				).rows;
				expect(runs).toEqual([{ automation: 'remind', state: 'succeeded' }]);
			})
		)
	);
});

describe('a started automation whose body fails', () => {
	it.live(
		'queues before execution, then records the body error rather than an unknown outcome',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(
						TestWorkspace.layer({
							manifest: {
								...manifest,
								policies: {
									ops: {
										description: 'Ops',
										grants: { quotes: { read: true, create: true, update: true } },
										automations: ['quotes_boom']
									}
								},
								automations: {
									quotes_boom: {
										description: 'Throws',
										input: {},
										runAs: 'trigger'
									}
								}
							},
							guest: yield* program(`export default {
	automation: { quotes_boom: { body: function* () { throw new Error('a bug'); } } },
};`),
							now: '2026-09-25T10:00:00.000Z'
						})
					);
					const t = Context.get(context, TestWorkspace);
					const queued = (yield* actReply(
						yield* routeFixture(context),
						t.as(t.member(['ops'])).authority,
						{
							callable: 'start',
							input: {
								automation: 'quotes_boom',
								runs: [{ id: uuidv7(Date.parse(t.clock.now())), input: {} }]
							},
							issuedAt: t.clock.now()
						}
					)).outcome;
					if (queued.kind !== 'committed') throw new Error('Failing workflow did not enqueue');
					const run = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
						queued.output
					);
					expect(
						yield* t.db.rows(
							Schema.Struct({ state: Schema.String, error: Schema.NullOr(Schema.Json) }),
							{
								text: 'SELECT state, error FROM sys_run WHERE id = $1',
								params: [run.id]
							}
						)
					).toEqual([{ state: 'queued', error: null }]);
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
