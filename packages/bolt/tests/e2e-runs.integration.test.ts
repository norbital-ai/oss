import { act_reply, q_reply, route_fixture } from './support/route-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { Context, Effect, Layer, Schema } from 'effect';
// End to end through the engine entry and the test kit: a model's create effect is queued by the act's own
// statement and runs as the writer; the delayed follow-up it schedules is announced to the deadlines port and runs its
// body when the deadline wakes (rules 49, 52a).
import { describe, expect, it } from '@effect/vitest';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
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
			record_label: 'record.title',
			fields: {
				title: { kind: 'text' },
				status: { kind: 'enum', values: ['draft', 'sent'], default: 'draft' }
			}
		}
	},
	relationships: {},
	exposures: {
		quotes: {
			outputs: { default: { quotes: { fields: 'all' } } },
			create: { columns: { quotes: ['title'] }, effect: true },
			update: { columns: { quotes: ['status'] } }
		}
	},
	policies: {
		// the writer's effect schedules the follow-up from code: no start grant needed
		ops: {
			description: 'Ops',
			grants: { quotes: { outputs: { default: true }, create: true, update: true } }
		}
	},
	automations: {
		remind: {
			description: 'Send an hour after creation',
			input: { ids: { kind: 'ref', to: 'quotes', many: true } },
			policies: ['ops']
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
const guestSource = `export default {
	model: { quotes: { bodies: { effect: { create: function* (changes, ctx) {
		yield* ctx.schedule('remind', { ids: changes.map((change) => change.after.id) }, { at: { var: 'now + hours(1)' } });
	} } } } },
	automation: { remind: { body: function* (input, ctx) {
		const { quotes } = yield* ctx.query({ quotes: { where: { id: { in: input.ids } } } });
		yield* ctx.act({ 'quotes.update': quotes.rows.map((row) => ({ target: row, set: { status: 'sent' } })) });
	} } }
};`;

describe('a created effect that schedules a delayed follow-up', () => {
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
					route = yield* route_fixture(context);
				const ops = yield* t.as(t.member(['ops']));
				const created = (yield* act_reply(route, ops.authority, {
					acts: { 'quotes.create': [{ title: 'q1' }] },
					issued_at: t.clock.now()
				})).outcome;
				if (created.kind !== 'committed' || created.records[0] === undefined)
					throw new Error('Missing created quote');
				const id = created.records[0].id;
				yield* t.run_due(); // the effect runs at its commit and schedules the follow-up an hour out
				expect(
					t.fakes.deadlines.announced.map(({ scope, at }) => ({ scope, at: Date.parse(at) }))
				).toContainEqual({
					scope: 'test',
					at: Date.parse('2026-09-25T11:00:00.000Z')
				});
				yield* t.run_due();
				expect(
					yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							quotes: Schema.Struct({
								rows: Schema.Array(Schema.Record(Schema.String, Schema.Json))
							})
						})
					)(
						(yield* q_reply(route, ops.authority, {
							reads: [{ m: 'query', a: [{ quotes: { where: { id: { eq: id } } } }] }]
						})).answers[0]
					).pipe(Effect.map((answer) => answer.quotes.rows[0]))
				).toMatchObject({ status: 'draft' });
				t.clock.advance('1h');
				yield* t.run_due();
				expect(
					yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							quotes: Schema.Struct({
								rows: Schema.Array(Schema.Record(Schema.String, Schema.Json))
							})
						})
					)(
						(yield* q_reply(route, ops.authority, {
							reads: [{ m: 'query', a: [{ quotes: { where: { id: { eq: id } } } }] }]
						})).answers[0]
					).pipe(Effect.map((answer) => answer.quotes.rows[0]))
				).toMatchObject({ status: 'sent' });
				const runs = present(
					(yield* t.db.read([
						{ text: 'SELECT automation, state, cause FROM sys_run ORDER BY due_at', params: [] }
					]))[0]
				).rows;
				expect(runs).toEqual([
					{ automation: 'quotes.effect.create', state: 'succeeded', cause: 'effect' },
					{ automation: 'remind', state: 'succeeded', cause: 'schedule' }
				]);
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
										grants: { quotes: { outputs: { default: true }, create: true, update: true } },
										capabilities: { automations: ['quotes_boom'] }
									}
								},
								automations: {
									quotes_boom: {
										description: 'Throws',
										input: {},
										policies: ['ops']
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
					const queued = (yield* act_reply(
						yield* route_fixture(context),
						(yield* t.as(t.member(['ops']))).authority,
						{
							callable: 'run',
							input: {
								automation: 'quotes_boom',
								id: uuidv7(Date.parse(t.clock.now())), input: {}
							},
							issued_at: t.clock.now()
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
					yield* t.run_due();
					const runs = present(
						(yield* t.db.read([
							{
								text: `SELECT state, error->>'code' AS code, error->>'message' AS message FROM sys_run`,
								params: []
							}
						]))[0]
					).rows;
					expect(runs).toEqual([{ state: 'failed', code: 'guest_error', message: 'a bug' }]);
				})
			)
	);
});
