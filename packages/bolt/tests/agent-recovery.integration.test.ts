import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema, Stream } from 'effect';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { agents } from '../src/engine/agent/index.ts';
import { TURN_RUN } from '../src/engine/agent/turns.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { Ai, Files, Images, type AiEvent } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { bindingsAt } from '../src/engine/query/reader.ts';
import { Approvals, Automations, Callables, Live, Reads, RunHandlers, Wake } from '../src/engine/services.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { manifest } from './catalogue-fixture.ts';

const agent_manifest = { ...manifest, agent: { ...manifest.agent, internal: 'Staff brief.' } };

const NOW = '2026-09-25T10:00:00.000Z';

/** Only the failed agent's database membrane is interrupted; assertions use the real backing PGlite. */
const recoverable_agent = Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest: agent_manifest, now: NOW }));
	const t = Context.get(context, TestWorkspace);
	const outage = DbError.make('08006', 'The agent database connection was lost.');
	const fault = { unavailable: false, during_model: false };
	const db = {
		...t.db,
		read: (...args: Parameters<typeof t.db.read>) => fault.unavailable ? Effect.fail(outage) : t.db.read(...args),
		write: (...args: Parameters<typeof t.db.write>) => fault.unavailable ? Effect.fail(outage) : t.db.write(...args)
	};
	const ai: Ai['Service'] = {
		...Context.get(context, Ai),
		models: ['default'],
		catalog: Effect.succeed({ models: [{ id: 'default', label: 'Default' }], default: 'default' }),
		infer: () => Stream.unwrap(Effect.sync(() => {
			if (fault.during_model) {
				fault.during_model = false;
				fault.unavailable = true;
				return Stream.fail(Port.failure('ai')({ kind: 'invalid', message: 'Provider refused the request.' }));
			}
			const event: AiEvent = { _tag: 'Response', response: { content: 'Recovered answer.', tool_calls: [], finish: 'stop', usage: { input: 1, output: 1 } } };
			return Stream.succeed(event);
		}))
	};
	const agent = yield* agents({
		engine: {
			manifest: t.manifest,
			db,
			live: Context.get(context, Live),
			calls: Context.get(context, Callables),
			automations: Context.get(context, Automations),
			read: Context.get(context, Reads).run,
			approvals: Context.get(context, Approvals)
		},
		ai,
		bindings: Effect.sync(() => bindingsAt(t.clock.now(), 'UTC')),
		announce: Context.get(context, Wake).at,
		media: { files: Context.get(context, Files), images: Context.get(context, Images) }
	}).pipe(Effect.provide(context));
	const authority = (yield* t.as(t.admin)).authority;
	if (authority.actor.kind !== 'member') throw new Error('The native administrator fixture is not a member.');
	const conversation = yield* agent.start({ owner: authority.actor.id });
	yield* agent.post({ conversation, as: { member: authority.actor.id }, text: 'Please answer this request.' });
	return { context, t, agent, conversation, fault, outage };
});

it.live('a recovery lookup distinguishes a missing chat from an unavailable database without consuming its queued input', () =>
	Effect.scoped(Effect.gen(function* () {
		const { context, t, agent, conversation, fault, outage } = yield* recoverable_agent;
		yield* Effect.gen(function* () {
			expect(yield* agent.turnRun({ conversation: randomUUID() }, (id) => agent.drain(id))).toMatchObject({ gone: true });
			fault.unavailable = true;
			expect(yield* Effect.flip(agent.turnRun({ conversation }, (id) => agent.drain(id)))).toBe(outage);
			expect(yield* t.db.rows(Schema.Struct({ state: Schema.String }), {
				text: `SELECT state FROM sys_message WHERE conversation = $1 AND role = 'user'`, params: [conversation]
			})).toEqual([{ state: 'queued' }]);
			expect(yield* t.db.value(Schema.Number, {
				text: `SELECT count(*)::int FROM sys_run WHERE automation = $1 AND state = 'queued' AND input->>'conversation' = $2`,
				params: [TURN_RUN, conversation]
			})).toBe(1);
		}).pipe(Effect.provide(context));
	}))
);

it.live('an outage while recording a failed turn retains its lease and queued takeover, which later produces its answer', () =>
	Effect.scoped(Effect.gen(function* () {
		const { context, t, agent, conversation, fault, outage } = yield* recoverable_agent;
		yield* Effect.gen(function* () {
			fault.during_model = true;
			expect(yield* Effect.flip(agent.drain(conversation))).toBe(outage);
			expect(yield* t.db.rows(Schema.Struct({ status: Schema.String, leased: Schema.Boolean }), {
				text: `SELECT status, lease_until IS NOT NULL AS leased FROM sys_conversation WHERE id = $1`, params: [conversation]
			})).toEqual([{ status: 'running', leased: true }]);
			expect(yield* t.db.value(Schema.Number, {
				text: `SELECT count(*)::int FROM sys_run WHERE automation = $1 AND state = 'queued' AND input->>'conversation' = $2`,
				params: [TURN_RUN, conversation]
			})).toBe(1);
			expect(yield* t.db.value(Schema.Number, {
				text: `SELECT count(*)::int FROM sys_message WHERE conversation = $1 AND role = 'assistant'`, params: [conversation]
			})).toBe(0);
			fault.unavailable = false;
			t.clock.advance('4min');
			yield* (yield* RunHandlers).register({
				[TURN_RUN]: (input) => agent.turnRun(input, (id) => agent.drain(id))
			});
			expect((yield* t.run_due()).failed).toEqual([]);
			expect(yield* t.db.rows(Schema.Struct({ status: Schema.String, lease_until: Schema.Null }), {
				text: `SELECT status, lease_until FROM sys_conversation WHERE id = $1`, params: [conversation]
			})).toEqual([{ status: 'idle', lease_until: null }]);
			expect((yield* agent.transcript(conversation)).filter((row) => row.role === 'assistant').map((row) => row.text)).toEqual(['Recovered answer.']);
			expect(yield* t.db.value(Schema.Number, {
				text: `SELECT count(*)::int FROM sys_run WHERE automation = $1 AND state = 'queued' AND input->>'conversation' = $2`,
				params: [TURN_RUN, conversation]
			})).toBe(0);
		}).pipe(Effect.provide(context));
	}))
);

it.live('native transient database attempts retry with SQLSTATE evidence while permanent decode failures stop after one attempt', () =>
	Effect.scoped(Effect.gen(function* () {
		const context = yield* Layer.build(TestWorkspace.layer({ manifest, now: NOW }));
		yield* Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const retry_id = randomUUID(), invalid_id = randomUUID(), protocol_id = randomUUID();
			let attempts = 0;
			const lost_transaction = TenantDb.typed({
				read: () => Effect.die(new Error('The contract fixture only submits a transaction.')),
				write: () => Effect.die(new Error('The contract fixture only submits a transaction.')),
				transaction: () => Effect.succeed([])
			});
			yield* (yield* RunHandlers).register({
				'test.database_recovery': () => Effect.suspend(() => ++attempts === 1
					? Effect.fail(DbError.make('08006', 'Native handler connection lost.'))
					: Effect.succeed({ recovered: true })),
				'test.invalid_native_input': () => Effect.fail(BoltError.make('invalid_input', 'decode', 'Malformed native input.')),
				'test.transaction_contract': () => lost_transaction.transaction({ statements: [{ text: 'UPDATE items SET value = 1', params: [] }] }).pipe(Effect.as({}))
			}, {
				'test.database_recovery': { attempts: 3, backoff: '10s' },
				'test.invalid_native_input': { attempts: 3, backoff: '10s' },
				'test.transaction_contract': { attempts: 3, backoff: '10s' }
			});
			const runs = [{ id: retry_id, automation: 'test.database_recovery' }, { id: invalid_id, automation: 'test.invalid_native_input' }, { id: protocol_id, automation: 'test.transaction_contract' }];
			for (const { id, automation } of runs)
				yield* t.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ($1, $2, '{}', $3::timestamptz, 'schedule', 0)`,
					params: [id, automation, NOW]
				});
			yield* t.run_due();
			expect(yield* t.db.rows(Schema.Struct({ state: Schema.String, attempts: Schema.Number, code: Schema.String, sqlstate: Schema.NullOr(Schema.String), recorded: Schema.NullOr(Schema.String) }), {
				text: `SELECT state, attempts, error->>'code' AS code, error->>'sqlstate' AS sqlstate, results->0->'error'->>'sqlstate' AS recorded FROM sys_run WHERE id = $1`,
				params: [retry_id]
			})).toEqual([{ state: 'queued', attempts: 1, code: 'upstream', sqlstate: '08006', recorded: '08006' }]);
			expect(yield* t.db.rows(Schema.Struct({ state: Schema.String, attempts: Schema.Number, code: Schema.String }), {
				text: `SELECT state, attempts, error->>'code' AS code FROM sys_run WHERE id = $1`, params: [invalid_id]
			})).toEqual([{ state: 'failed', attempts: 1, code: 'invalid_input' }]);
			expect(yield* t.db.rows(Schema.Struct({ state: Schema.String, attempts: Schema.Number, sqlstate: Schema.String, uncertain: Schema.Boolean, recorded: Schema.Boolean }), {
				text: `SELECT state, attempts, error->>'sqlstate' AS sqlstate, error->'outcome_unknown' AS uncertain, results->0->'error'->'outcome_unknown' AS recorded FROM sys_run WHERE id = $1`, params: [protocol_id]
			})).toEqual([{ state: 'failed', attempts: 1, sqlstate: 'XX000', uncertain: true, recorded: true }]);
			t.clock.advance('1min');
			yield* t.run_due();
			expect(yield* t.db.rows(Schema.Struct({ state: Schema.String, attempts: Schema.Number, error: Schema.Null, output: Schema.Struct({ recovered: Schema.Boolean }) }), {
				text: `SELECT state, attempts, error, output FROM sys_run WHERE id = $1`, params: [retry_id]
			})).toEqual([{ state: 'succeeded', attempts: 2, error: null, output: { recovered: true } }]);
		}).pipe(Effect.provide(context));
	}))
);
