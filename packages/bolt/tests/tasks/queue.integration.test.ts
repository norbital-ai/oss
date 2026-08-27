import { PGlite } from '@electric-sql/pglite';
import { Effect } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchemaPlan } from '../../src/compiler/schema-plan.js';
import type { WorkspaceDefinition } from '../../src/authoring/workspace-schema.js';
import {
	dequeueStatement,
	enqueueStatements,
	interruptLaneStatement,
	makeQueue,
	reorderStatements,
	resumeLaneStatements,
	slotEffectId,
	stopLaneStatements,
	type ExecuteStatements
} from '../../src/runtime/tasks/queue.js';
import { makeRunner, type Run } from '../../src/runtime/tasks/runner.js';

/**
 * The queue is exercised against a real Postgres, driven through the same batch seam a host binds.
 *
 * Asserting on generated SQL strings would only prove the composer emits what its author expected.
 * Everything load-bearing here is a *database* guarantee — the unique index that makes cron
 * exactly-once, `for update skip locked` inside an update's subquery, `least` ignoring nulls, a
 * partial index over a status — and none of those are checkable by reading a string.
 */

/**
 * The plan steps that create the tables a tick touches, read out of the plan rather than restated.
 *
 * The sync tables are here because `finish` compacts the outbox in the same batch it prunes terminal
 * task rows in. A tick reaches them whether or not this suite is about them, so a harness that
 * omitted them would fail every test in the file on a missing relation.
 */
const taskSchemaSteps = () =>
	buildSchemaPlan({
		name: 'tasks',
		collections: [],
		customTypes: {},
		policies: [],
		relations: []
	} as unknown as WorkspaceDefinition).steps.filter(
		(step) =>
			step.id.startsWith('collection:bolt_task') ||
			step.id.startsWith('collection:bolt_schedule') ||
			step.id.startsWith('collection:agent_mailbox') ||
			step.id.startsWith('collection:bolt_sync_outbox') ||
			step.id.startsWith('collection:bolt_sync_horizon')
	);

const at = (iso: string): number => Date.parse(iso);

/**
 * Due times are compared against the *database's* `now()`, so anything meant to be due has to be
 * genuinely in the past and anything meant to wait has to be genuinely in the future. These derive
 * both from the real clock rather than from a written-down instant, which is why they take a
 * reference: an assertion on a hard-coded 2026 timestamp passes for a day and then reads as a bug.
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The most recent whole hour at or before `from`. */
const hourAt = (from: number): number => Math.floor(from / HOUR_MS) * HOUR_MS;

/** The first `06:00` UTC strictly after `from` — what `0 6 * * *` names next. */
const nextDailySix = (from: number): number => {
	const moment = new Date(from);
	const today = Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate(), 6);
	return today > from ? today : today + DAY_MS;
};

describe('bolt task queue over a host facility', () => {
	let database: PGlite;
	let execute: ExecuteStatements;

	beforeAll(async () => {
		database = await PGlite.create('memory://');
		// The facility's own semantics, and the two that matter are easy to get wrong: a batch is one
		// transaction, and its answer is every statement's rows concatenated.
		execute = (statements) =>
			Effect.promise(async () => {
				const rows: Array<Record<string, unknown>> = [];
				await database.exec('begin');
				try {
					for (const statement of statements) {
						const result = await database.query<Record<string, unknown>>(statement.sql, [
							...statement.parameters
						]);
						rows.push(...result.rows);
					}
					await database.exec('commit');
				} catch (cause) {
					await database.exec('rollback');
					throw cause;
				}
				// The one place a real host differs and a test must not: every value crossing the wire is
				// JSON-safe, so a timestamp arrives as an ISO string rather than as a `Date`.
				return rows.map((row) =>
					Object.fromEntries(
						Object.entries(row).map(([key, value]) => [
							key,
							value instanceof Date ? value.toISOString() : value
						])
					)
				);
			});
		for (const step of taskSchemaSteps()) await database.exec(step.sql);
	});

	afterAll(async () => {
		await database.close();
	});

	beforeEach(async () => {
		await database.exec('delete from bolt_task; delete from bolt_schedule');
	});

	const effectQueue = () => makeQueue(execute);
	const queue = () => {
		const effects = effectQueue();
		return {
			...effects,
			declare: (...arguments_: Parameters<typeof effects.declare>) =>
				Effect.runPromise(effects.declare(...arguments_)),
			roll: (...arguments_: Parameters<typeof effects.roll>) =>
				Effect.runPromise(effects.roll(...arguments_)),
			take: (...arguments_: Parameters<typeof effects.take>) =>
				Effect.runPromise(effects.take(...arguments_)),
			finish: (...arguments_: Parameters<typeof effects.finish>) =>
				Effect.runPromise(effects.finish(...arguments_)),
			when: () => Effect.runPromise(effects.when())
		};
	};
	const runStatements = (statements: Parameters<ExecuteStatements>[0]) =>
		Effect.runPromise(execute(statements));

	const tasks = async () =>
		(
			await database.query<Record<string, unknown>>(
				'select id, command, lane, position, status, attempts, max_attempts, effect_id, error, result, run_at from bolt_task order by created_at, effect_id'
			)
		).rows;

	const schedules = async () =>
		(
			await database.query<Record<string, unknown>>(
				'select key, command, crontab, next_run_at, last_fired_at from bolt_schedule order by key'
			)
		).rows;

	it('applies its schema through the plan, and re-applies safely', async () => {
		// `schema.migrate` runs on every deploy, so a statement that is not idempotent breaks the
		// second one rather than the first.
		for (const step of taskSchemaSteps()) await database.exec(step.sql);
		const found = await database.query<{ table_name: string }>(
			"select table_name from information_schema.tables where table_name in ('bolt_task', 'bolt_schedule') order by table_name"
		);
		expect(found.rows.map((row) => row.table_name)).toEqual(['bolt_schedule', 'bolt_task']);
	});

	describe('declare', () => {
		it('upserts what the release declares and deletes what it does not', async () => {
			const now = at('2026-08-20T04:00:00.000Z');
			await queue().declare(
				[
					{
						key: 'automations.digest',
						command: 'automations.digest',
						crontab: '0 6 * * *',
						input: {}
					},
					{ key: 'automations.gone', command: 'automations.gone', crontab: '0 7 * * *', input: {} }
				],
				now
			);
			expect((await schedules()).map((row) => row.key)).toEqual([
				'automations.digest',
				'automations.gone'
			]);
			const second = await queue().declare(
				[
					{
						key: 'automations.digest',
						command: 'automations.digest',
						crontab: '0 6 * * *',
						input: {}
					}
				],
				now
			);
			expect((await schedules()).map((row) => row.key)).toEqual(['automations.digest']);
			// A release with schedules is a release with a next due instant, and that is the number the
			// host arms its timer to. Nothing else in the design tells it when to come back.
			expect(second.nextDueAtEpochMs).toBe(at('2026-08-20T06:00:00.000Z'));
		});

		it('leaves a redeploy alone but re-arms a schedule whose expression changed', async () => {
			const now = at('2026-08-20T04:00:00.000Z');
			const declaration = {
				key: 'automations.digest',
				command: 'automations.digest',
				crontab: '0 6 * * *',
				input: {}
			};
			await queue().declare([declaration], now);
			// A deploy is not an event a schedule should observe: re-arming on every deploy is how a
			// nightly digest quietly stops firing on a day with enough deploys in it.
			await queue().declare([declaration], at('2026-08-20T05:59:00.000Z'));
			expect(new Date(String((await schedules())[0]?.next_run_at)).toISOString()).toBe(
				'2026-08-20T06:00:00.000Z'
			);
			await queue().declare([{ ...declaration, crontab: '0 9 * * *' }], now);
			expect(new Date(String((await schedules())[0]?.next_run_at)).toISOString()).toBe(
				'2026-08-20T09:00:00.000Z'
			);
		});

		it('reports an expression it cannot read rather than storing it', async () => {
			const declared = await queue().declare(
				[{ key: 'automations.bad', command: 'automations.bad', crontab: '@hourly', input: {} }],
				at('2026-08-20T04:00:00.000Z')
			);
			expect(declared.rejections).toHaveLength(1);
			expect(declared.rejections[0]?.key).toBe('automations.bad');
			// Rejected at the one point a person is watching — a deploy — rather than stored as a row
			// that can never fire.
			expect(await schedules()).toHaveLength(0);
			expect(declared.nextDueAtEpochMs).toBeUndefined();
		});
	});

	describe('roll', () => {
		it('turns a due schedule into one task keyed at the stored slot, and advances', async () => {
			const now = Date.now();
			const slot = nextDailySix(now) - DAY_MS * 2;
			await queue().declare(
				[
					{
						key: 'automations.digest',
						command: 'automations.digest',
						crontab: '0 6 * * *',
						input: { a: 1 }
					}
				],
				now
			);
			await database.exec(
				`update bolt_schedule set next_run_at = '${new Date(slot).toISOString()}'`
			);
			const rolled = await queue().roll(now);
			expect(rolled.rolled).toBe(1);
			await runStatements(rolled.statements);
			const [task] = await tasks();
			expect(task?.command).toBe('automations.digest');
			expect(task?.effect_id).toBe(slotEffectId('automations.digest', slot));
			// `run_at` is the slot, not the moment the tick noticed it, so the row says when it was due.
			expect(new Date(String(task?.run_at)).getTime()).toBe(slot);
			// One occurrence fired; the schedule rejoins its own rhythm rather than replaying two days
			// of missed mornings.
			expect(new Date(String((await schedules())[0]?.next_run_at)).getTime()).toBe(
				nextDailySix(now)
			);
		});

		it('fires a missed occurrence exactly once, however long the host was away', async () => {
			// Hourly, and a host down from 06:00 to 08:30. Advancing from `next_run_at` alone would
			// reach 07:00, find that still due, and fire three times; advancing from `max(now, slot)`
			// fires the missed slot once and rejoins the rhythm.
			const now = Date.now();
			const missed = hourAt(now) - HOUR_MS * 3;
			await queue().declare(
				[
					{
						key: 'integrations.pull:rfis.erp',
						command: 'integrations.pull',
						crontab: '0 * * * *',
						input: {}
					}
				],
				now
			);
			await database.exec(
				`update bolt_schedule set next_run_at = '${new Date(missed).toISOString()}'`
			);
			const rolled = await queue().roll(now);
			await runStatements(rolled.statements);
			expect(await tasks()).toHaveLength(1);
			expect(new Date(String((await schedules())[0]?.next_run_at)).getTime()).toBe(
				hourAt(now) + HOUR_MS
			);
			// And the next tick, still inside the same hour, finds nothing due.
			const again = await queue().roll(now + 1_000);
			expect(again.rolled).toBe(0);
		});

		it('gives one slot to one task however many hosts notice it', async () => {
			const now = Date.now();
			await queue().declare(
				[
					{
						key: 'automations.digest',
						command: 'automations.digest',
						crontab: '0 6 * * *',
						input: {}
					}
				],
				now
			);
			await database.exec(
				`update bolt_schedule set next_run_at = '${new Date(nextDailySix(now) - DAY_MS).toISOString()}'`
			);
			// Two hosts, each reading the stored slot before either has written anything back.
			const first = await queue().roll(now);
			const second = await queue().roll(now + 1_000);
			// Two hosts that both read the same stored slot compute the same `effect_id`, so the unique
			// index picks a winner and the loser's insert is a no-op. No leader election anywhere.
			await runStatements(first.statements);
			await runStatements(second.statements);
			expect(await tasks()).toHaveLength(1);
		});

		it('retires a schedule that cannot advance instead of spinning on it', async () => {
			// A row that cannot fire is not neutral: `when` would keep answering "due now", so the host
			// would re-arm immediately and tick forever against a row that does nothing.
			await database.exec(
				"insert into bolt_schedule (key, command, crontab, input, next_run_at) values ('automations.bad', 'automations.bad', 'not a cron', '{}', now() - interval '1 minute')"
			);
			const rolled = await queue().roll(Date.now());
			expect(rolled.rejections).toHaveLength(1);
			await runStatements(rolled.statements);
			expect(await schedules()).toHaveLength(0);
			expect(await tasks()).toHaveLength(0);
		});
	});

	describe('take', () => {
		const enqueue = async (effectId: string, runAt?: string) =>
			runStatements(
				queue().enqueueStatements([
					{
						command: 'integrations.flush',
						input: {},
						effectId,
						...(runAt === undefined ? {} : { runAtEpochMs: at(runAt) })
					}
				])
			);

		it('hides what it hands out, and hands it out once', async () => {
			await enqueue('one');
			const taken = await queue().take([], { hideForMillis: 60_000, batchSize: 5 });
			expect(taken.map((task) => task.effectId)).toEqual(['one']);
			expect(taken[0]?.attempts).toBe(1);
			// The row is visibly `running`; its future `run_at` is the crash-recovery lease.
			const [row] = await tasks();
			expect(row?.status).toBe('running');
			expect(await queue().take([], { hideForMillis: 60_000, batchSize: 5 })).toEqual([]);
		});

		it('gives a taken-and-abandoned task back when its hide expires, one attempt poorer', async () => {
			await enqueue('one');
			await queue().take([], { hideForMillis: 60_000, batchSize: 5 });
			// Exactly what a tick that died mid-run leaves behind: nothing was written after the take.
			await database.exec("update bolt_task set run_at = now() - interval '1 second'");
			const retaken = await queue().take([], { hideForMillis: 60_000, batchSize: 5 });
			expect(retaken[0]?.attempts).toBe(2);
		});

		it('clears the prior failure when retry work is claimed', async () => {
			await enqueue('retry');
			const [first] = await queue().take([], { hideForMillis: 60_000, batchSize: 1 });
			if (first === undefined) throw new Error('nothing to take');
			await queue().finish([
				{ _tag: 'Failed', task: first, error: 'provider unavailable', retryable: true }
			]);
			expect((await tasks())[0]?.error).toBe('provider unavailable');

			await database.exec("update bolt_task set run_at = now() - interval '1 second'");
			await queue().take([], { hideForMillis: 60_000, batchSize: 1 });
			expect((await tasks())[0]?.error).toBeNull();
		});

		it('takes the oldest due work first and nothing that is not due', async () => {
			const now = Date.now();
			await enqueue('later', new Date(now - 60_000).toISOString());
			await enqueue('earlier', new Date(now - 120_000).toISOString());
			await enqueue('future', '2999-01-01T00:00:00.000Z');
			// Which rows are chosen is ordered; the order they come *back* in is not, because
			// `returning` reports the order the update touched them. Asked for one, the queue hands over
			// the oldest due row — which is the only ordering claim the runner relies on.
			expect((await queue().take([], { hideForMillis: 60_000, batchSize: 1 }))[0]?.effectId).toBe(
				'earlier'
			);
			const rest = await queue().take([], { hideForMillis: 60_000, batchSize: 10 });
			// And a task that is not due yet is not work, however long the queue has been idle.
			expect(rest.map((task) => task.effectId)).toEqual(['later']);
		});

		it('commits the writes it was handed even when it may take nothing', async () => {
			// The floor case: a tick with no time left still has to land `roll`'s advance, or the
			// schedule fires its next occurrence twice.
			const rolled = queue().enqueueStatements([
				{ command: 'automations.digest', input: {}, effectId: 'rolled' }
			]);
			expect(await queue().take(rolled, { hideForMillis: 0, batchSize: 0 })).toEqual([]);
			expect((await tasks()).map((row) => row.effect_id)).toEqual(['rolled']);
		});
	});

	describe('finish', () => {
		const takeOne = async (effectId: string) => {
			await runStatements(
				queue().enqueueStatements([{ command: 'integrations.flush', input: {}, effectId }])
			);
			const [task] = await queue().take([], { hideForMillis: 60_000, batchSize: 1 });
			if (task === undefined) throw new Error('nothing to take');
			return task;
		};

		it('records a success', async () => {
			const task = await takeOne('one');
			await queue().finish([{ _tag: 'Done', task, result: { delivered: 2 } }]);
			const [row] = await tasks();
			expect(row?.status).toBe('done');
			expect(row?.result).toEqual({ delivered: 2 });
		});

		it('preserves cancellation when an in-flight worker finishes later', async () => {
			const task = await takeOne('cancelled-in-flight');
			// Cancellation can race with either a success or failure reported by that worker.
			await database.query(
				"update bolt_task set status = 'failed', error = 'cancelled' where effect_id = $1 and status = 'running'",
				['cancelled-in-flight']
			);
			await queue().finish([{ _tag: 'Done', task, result: { delivered: 2 } }]);

			const [row] = await tasks();
			expect(row).toMatchObject({
				status: 'failed',
				error: 'cancelled',
				result: null
			});
		});

		it('fences a stopped in-flight run and reclaims the same row only after its lease', async () => {
			const task = await takeOne('stopped-in-flight');
			await database.query(
				"update bolt_task set status = 'paused' where effect_id = $1 and status = 'running'",
				['stopped-in-flight']
			);
			// A late answer from the old guest cannot turn the stopped row terminal.
			await queue().finish([{ _tag: 'Done', task, result: { delivered: 2 } }]);
			expect((await tasks())[0]).toMatchObject({
				effect_id: 'stopped-in-flight',
				status: 'paused',
				result: null
			});

			// Resume retains the claim-time lease as a fence. The old guest has until that instant to
			// disappear, so neither it nor a new guest can own the same durable run concurrently.
			await database.query(
				"update bolt_task set status = 'resuming' where effect_id = $1 and status = 'paused'",
				['stopped-in-flight']
			);
			expect(await queue().take([], { hideForMillis: 60_000, batchSize: 1 })).toEqual([]);
			await database.exec("update bolt_task set run_at = now() - interval '1 second'");
			const [resumed] = await queue().take([], { hideForMillis: 60_000, batchSize: 1 });
			expect(resumed).toMatchObject({ effectId: 'stopped-in-flight', attempts: 2 });
			expect((await tasks())[0]?.status).toBe('running');
		});

		it('spaces a failure out rather than sleeping on it', async () => {
			const task = await takeOne('one');
			// Full jitter, pinned so the assertion is about the schedule and not about the die roll.
			await queue().finish(
				[{ _tag: 'Failed', task, error: 'status 503', retryable: true }],
				() => 1
			);
			const [row] = await tasks();
			expect(row?.status).toBe('pending');
			expect(row?.error).toBe('status 503');
			const delay = new Date(String(row?.run_at)).getTime() - Date.now();
			// `min(10s · 2^(attempts-1), 1h)` at attempt 1, under equal jitter — so `[5s, 10s]` — and
			// nothing at all is held open while it waits.
			expect(delay).toBeGreaterThan(9_000);
			expect(delay).toBeLessThanOrEqual(10_500);
		});

		it('gives up when the attempts are spent, and leaves the row as the audit trail', async () => {
			const task = await takeOne('one');
			await queue().finish([
				{
					_tag: 'Failed',
					task: { ...task, attempts: 12, maxAttempts: 12 },
					error: 'status 500',
					retryable: true
				}
			]);
			const [row] = await tasks();
			expect(row?.status).toBe('failed');
			expect(row?.error).toBe('status 500');
			// Re-driving is an update, which is why there is no dead-letter table to look in.
			await database.exec("update bolt_task set status = 'pending', attempts = 0, run_at = now()");
			expect(await queue().take([], { hideForMillis: 60_000, batchSize: 1 })).toHaveLength(1);
		});

		it('fails a non-retryable outcome immediately without spending the remaining attempts', async () => {
			const task = await takeOne('one');
			await queue().finish([
				{ _tag: 'Failed', task, error: 'already committed', retryable: false }
			]);
			const [row] = await tasks();
			expect(row?.status).toBe('failed');
			expect(row?.attempts).toBe(1);
			expect(row?.error).toBe('already committed');
		});

		it('prunes what nobody will read again, and only that', async () => {
			await database.exec(`insert into bolt_task (command, input, effect_id, status, updated_at) values
				('a', '{}', 'old-done', 'done', now() - interval '8 days'),
				('a', '{}', 'new-done', 'done', now() - interval '1 day'),
				('a', '{}', 'old-failed', 'failed', now() - interval '31 days'),
				('a', '{}', 'new-failed', 'failed', now() - interval '8 days')`);
			await queue().finish([]);
			expect((await tasks()).map((row) => row.effect_id).toSorted()).toEqual([
				'new-done',
				'new-failed'
			]);
		});
	});

	describe('serial agent lanes', () => {
		const lane = 'conversation-agent';
		const command = 'agents.execute';
		const enqueueLane = async (...effectIds: ReadonlyArray<string>) =>
			runStatements(
				enqueueStatements(
					effectIds.map((effectId) => ({
						command,
						input: { conversationId: lane, turnId: effectId, agent: 'web' },
						effectId,
						lane
					}))
				)
			);

		it('runs only the first due item in a lane until that item settles', async () => {
			await enqueueLane('first', 'second');
			const [first] = await queue().take([], { hideForMillis: 60_000, batchSize: 10 });
			expect(first?.effectId).toBe('first');
			expect(await queue().take([], { hideForMillis: 60_000, batchSize: 10 })).toEqual([]);
			if (first === undefined) throw new Error('first lane item was not claimed');
			await queue().finish([{ _tag: 'Done', task: first, result: null }]);
			const [second] = await queue().take([], { hideForMillis: 60_000, batchSize: 10 });
			expect(second?.effectId).toBe('second');
		});

		it('reorders, dequeues, stops, resumes, and interrupts the same durable rows', async () => {
			await enqueueLane('one', 'two', 'three');
			await runStatements(reorderStatements(lane, command, ['three', 'one', 'two']));
			const ordered = await database.query<{ effect_id: string }>(
				`select effect_id from bolt_task
				 where lane = $1 and status in ('pending', 'paused', 'resuming')
				 order by position`,
				[lane]
			);
			expect(ordered.rows.map(({ effect_id }) => effect_id)).toEqual(['three', 'one', 'two']);

			await runStatements([dequeueStatement('one', lane, command)]);
			expect((await tasks()).find(({ effect_id }) => effect_id === 'one')?.status).toBe('dequeued');
			const [running] = await queue().take([], { hideForMillis: 60_000, batchSize: 1 });
			expect(running?.effectId).toBe('three');

			await runStatements(stopLaneStatements(lane, command));
			expect(
				(
					await database.query<{ status: string }>(
						'select status from agent_mailbox where conversation_id = $1',
						[lane]
					)
				).rows[0]?.status
			).toBe('paused');
			expect(
				(await tasks())
					.filter(({ effect_id }) => effect_id === 'three' || effect_id === 'two')
					.map(({ status }) => status)
			).toEqual(['paused', 'paused']);
			if (running === undefined) throw new Error('first reordered item was not claimed');
			await queue().finish([{ _tag: 'Done', task: running, result: null }]);
			expect((await tasks()).find(({ effect_id }) => effect_id === 'three')?.status).toBe('paused');

			await runStatements(resumeLaneStatements(lane, command));
			const [resumed] = await queue().take([], { hideForMillis: 60_000, batchSize: 1 });
			expect(resumed?.effectId).toBe('three');
			await runStatements([interruptLaneStatement(lane, command)]);
			expect((await tasks()).find(({ effect_id }) => effect_id === 'three')?.status).toBe(
				'interrupted'
			);
			const [remaining] = await queue().take([], { hideForMillis: 60_000, batchSize: 1 });
			expect(remaining?.effectId).toBe('two');
		});
	});

	describe('when', () => {
		it('answers the earliest of a queued task and a schedule, and nothing when there is neither', async () => {
			expect(await queue().when()).toBeUndefined();
			await queue().declare(
				[
					{
						key: 'automations.digest',
						command: 'automations.digest',
						crontab: '0 6 * * *',
						input: {}
					}
				],
				at('2026-08-20T04:00:00.000Z')
			);
			expect(await queue().when()).toBe(at('2026-08-20T06:00:00.000Z'));
			await runStatements(
				queue().enqueueStatements([
					{
						command: 'integrations.flush',
						input: {},
						effectId: 'sooner',
						runAtEpochMs: at('2026-08-20T05:00:00.000Z')
					}
				])
			);
			// `least` ignores nulls, so one table being empty is not a third case to write.
			expect(await queue().when()).toBe(at('2026-08-20T05:00:00.000Z'));
		});
	});

	describe('a tick', () => {
		const ran: Array<{ command: string; attemptEffectId: string }> = [];
		const run: Run<never, never> = (task, attemptEffectId) =>
			Effect.sync(() => {
				ran.push({ command: task.command, attemptEffectId });
				return { _tag: 'Done', task, result: null };
			});

		beforeEach(() => {
			ran.length = 0;
		});

		it('rolls, runs what it rolled, and reports when to come back', async () => {
			await queue().declare(
				[
					{
						key: 'automations.digest',
						command: 'automations.digest',
						crontab: '0 6 * * *',
						input: {}
					}
				],
				Date.now()
			);
			await database.exec("update bolt_schedule set next_run_at = now() - interval '1 second'");
			const report = await Effect.runPromise(
				makeRunner(effectQueue(), run).tick({ nowEpochMs: Date.now(), remainingMillis: 60_000 })
			);
			// A schedule that comes due this instant is run by *this* tick, because the roll's insert and
			// the take commit together.
			expect(report.rolled).toBe(1);
			expect(report.ran).toBe(1);
			expect(ran[0]?.command).toBe('automations.digest');
			expect(report.nextDueAtEpochMs).toBeGreaterThan(Date.now());
			expect((await tasks())[0]?.status).toBe('done');
		});

		it('runs each attempt under its own effect id', async () => {
			await runStatements(
				queue().enqueueStatements([{ command: 'integrations.flush', input: {}, effectId: 'one' }])
			);
			await Effect.runPromise(
				makeRunner(effectQueue(), run).tick({ nowEpochMs: Date.now(), remainingMillis: 60_000 })
			);
			// Every facility is idempotent on `(scope, effectId)`. An attempt that reused the previous
			// attempt's id would be answered with its cached result — a retry that reports success while
			// doing nothing at all.
			expect(ran[0]?.attemptEffectId).toBe('one:1');
		});

		it('declines to take work it has no time to finish, and still keeps the host armed', async () => {
			await queue().declare(
				[
					{
						key: 'automations.digest',
						command: 'automations.digest',
						crontab: '0 6 * * *',
						input: {}
					}
				],
				Date.now()
			);
			await database.exec("update bolt_schedule set next_run_at = now() - interval '1 second'");
			const report = await Effect.runPromise(
				makeRunner(effectQueue(), run).tick({ nowEpochMs: Date.now(), remainingMillis: 1 })
			);
			// Taking here would hide the row for a millisecond, hand it to the next tick, and burn an
			// attempt on work nobody ever tried.
			expect(report.declined).toBe(true);
			expect(report.ran).toBe(0);
			expect(ran).toHaveLength(0);
			// But the roll still landed, and the schedule still advanced exactly once.
			expect(report.rolled).toBe(1);
			expect(await tasks()).toHaveLength(1);
			expect(report.nextDueAtEpochMs).toBeDefined();
		});

		it('carries a failure back to the row rather than out of the tick', async () => {
			await runStatements(
				queue().enqueueStatements([{ command: 'integrations.flush', input: {}, effectId: 'one' }])
			);
			const report = await Effect.runPromise(
				makeRunner(effectQueue(), (task) =>
					Effect.succeed({
						_tag: 'Failed' as const,
						task,
						error: 'partner unavailable',
						retryable: true
					})
				).tick({ nowEpochMs: Date.now(), remainingMillis: 60_000 })
			);
			expect(report.ran).toBe(1);
			const [row] = await tasks();
			expect(row?.status).toBe('pending');
			expect(row?.error).toBe('partner unavailable');
		});
	});
});
