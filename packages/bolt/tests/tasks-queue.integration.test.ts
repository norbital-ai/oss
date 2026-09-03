import { PGlite } from '@electric-sql/pglite';
import { Effect } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workspace } from '../src/authoring/workspace-schema.js';
import { buildSchemaPlan } from '../src/runtime/schema/schema-plan.js';
import {
	makeQueue,
	recoverStatements,
	slotEffectId,
	stopStatement,
	type ExecuteStatements
} from '../src/runtime/tasks/queue.js';

/** Real Postgres semantics prove claims, leases, retries and cron advancement together. */
const taskSchemaSteps = () =>
	buildSchemaPlan(
		workspace({
			name: 'tasks',
			version: '1',
			collections: [],
			apps: [],
			policies: [],
			relations: [],
			prompt: 'You are the test workspace agent.',
			tools: [],
			skills: [],
			automations: [],
			envoys: [],
			integrations: [],
			requiredFacilities: []
		})
	).steps.filter(
		(step) =>
			step.id.startsWith('collection:bolt_task') || step.id.startsWith('collection:bolt_schedule')
	);

const HOUR_MILLIS = 3_600_000;
const DAY_MILLIS = 24 * HOUR_MILLIS;
const LEASE_MILLIS = 60_000;
const at = (iso: string): number => Date.parse(iso);
const hourAt = (instant: number): number => Math.floor(instant / HOUR_MILLIS) * HOUR_MILLIS;
const nextDailySix = (instant: number): number => {
	const moment = new Date(instant);
	const today = Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate(), 6);
	return today > instant ? today : today + DAY_MILLIS;
};

describe('durable task queue over a host facility', () => {
	let database: PGlite;
	let execute: ExecuteStatements;

	beforeAll(async () => {
		database = await PGlite.create('memory://');
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
			declare: (...args: Parameters<typeof effects.declare>) =>
				Effect.runPromise(effects.declare(...args)),
			fire: (nowEpochMs: number, leaseForMillis = LEASE_MILLIS) =>
				Effect.runPromise(effects.fire(nowEpochMs, leaseForMillis)),
			settle: (...args: Parameters<typeof effects.settle>) =>
				Effect.runPromise(effects.settle(...args)),
			when: () => Effect.runPromise(effects.when())
		};
	};
	const runStatements = (statements: Parameters<ExecuteStatements>[0]) =>
		Effect.runPromise(execute(statements));
	const tasks = async () =>
		(
			await database.query<Record<string, unknown>>(
				`select id, command, status, effect_id, error, result, run_at, lease_expires_at,
				        attempts, max_attempts
				 from bolt_task order by created_at, effect_id`
			)
		).rows;
	const schedules = async () =>
		(
			await database.query<Record<string, unknown>>(
				'select key, command, crontab, next_run_at, last_fired_at from bolt_schedule order by key'
			)
		).rows;

	it('applies the durable queue schema repeatedly', async () => {
		for (const step of taskSchemaSteps()) await database.exec(step.sql);
		const columns = await database.query<{ column_name: string }>(
			`select column_name from information_schema.columns
			 where table_name = 'bolt_task' order by column_name`
		);
		expect(columns.rows.map(({ column_name }) => column_name)).toEqual(
			expect.arrayContaining(['attempts', 'lease_expires_at', 'max_attempts', 'run_at'])
		);
		expect(columns.rows.map(({ column_name }) => column_name)).not.toContain('lane');
	});

	it('upserts declarations, preserves an unchanged slot, and retires omissions', async () => {
		const now = at('2026-08-20T04:00:00.000Z');
		const digest = {
			key: 'automations.digest',
			command: 'automations.digest',
			crontab: '0 6 * * *',
			input: {}
		};
		await queue().declare(
			[digest, { ...digest, key: 'automations.gone', command: 'automations.gone' }],
			now
		);
		await queue().declare([digest], now + 60_000);
		expect((await schedules()).map(({ key }) => key)).toEqual(['automations.digest']);
		expect(new Date(String((await schedules())[0]?.next_run_at)).toISOString()).toBe(
			'2026-08-20T06:00:00.000Z'
		);
		expect(await queue().when()).toBe(at('2026-08-20T06:00:00.000Z'));
	});

	it('rejects an unreadable cron expression instead of storing a hot-looping row', async () => {
		const result = await queue().declare(
			[{ key: 'automations.bad', command: 'automations.bad', crontab: '@hourly', input: {} }],
			Date.now()
		);
		expect(result.rejections).toMatchObject([{ key: 'automations.bad' }]);
		expect(await schedules()).toEqual([]);
		expect(result.nextDueAtEpochMs).toBeUndefined();
	});

	it('rolls and claims one due cron occurrence with a finite lease', async () => {
		const now = Date.now();
		const slot = nextDailySix(now) - DAY_MILLIS;
		await queue().declare(
			[
				{
					key: 'automations.digest',
					command: 'automations.digest',
					crontab: '0 6 * * *',
					input: { tenant: 'a' }
				}
			],
			now
		);
		await database.exec(`update bolt_schedule set next_run_at = '${new Date(slot).toISOString()}'`);
		const fired = await queue().fire(now);
		expect(fired.rolled).toBe(1);
		expect(fired.occurrences).toMatchObject([
			{
				command: 'automations.digest',
				taskId: slotEffectId('automations.digest', slot),
				scheduleKey: 'automations.digest',
				scheduledForEpochMs: slot,
				attempt: 1
			}
		]);
		expect((await tasks())[0]).toMatchObject({
			status: 'running',
			attempts: 1,
			effect_id: slotEffectId('automations.digest', slot)
		});
		expect((await tasks())[0]?.lease_expires_at).not.toBeNull();
		expect(new Date(String((await schedules())[0]?.next_run_at)).getTime()).toBe(nextDailySix(now));
	});

	it('fires one missed cron occurrence and rejoins the current rhythm', async () => {
		const now = Date.now();
		const missed = hourAt(now) - 3 * HOUR_MILLIS;
		await queue().declare(
			[
				{
					key: 'integrations.pull:erp',
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
		const first = await queue().fire(now);
		expect(first.occurrences).toHaveLength(1);
		await queue().settle(first.occurrences[0]!.taskId, 1, { _tag: 'Done', result: null });
		expect((await queue().fire(now + 1_000)).occurrences).toHaveLength(0);
		expect(await tasks()).toHaveLength(1);
	});

	it('discovers a due direct task row through the same claim path', async () => {
		await database.exec(
			`insert into bolt_task (command, input, effect_id) values
			 ('integrations.pull', '{"name":"erp","cursor":null}', 'direct-pull')`
		);
		const fired = await queue().fire(Date.now());
		expect(fired.rolled).toBe(0);
		expect(fired.occurrences).toMatchObject([
			{
				taskId: 'direct-pull',
				scheduleKey: 'task:direct-pull',
				command: 'integrations.pull',
				input: { name: 'erp', cursor: null },
				attempt: 1
			}
		]);
	});

	it('keeps deferred direct work asleep and reports its exact wake time', async () => {
		const future = Date.now() + HOUR_MILLIS;
		await database.exec(
			`insert into bolt_task (command, input, effect_id, run_at) values
			 ('envoys.drain', '{}', 'deferred-drain', '${new Date(future).toISOString()}')`
		);
		expect((await queue().fire(Date.now())).occurrences).toEqual([]);
		expect(await queue().when()).toBe(future);
	});

	it('atomically hands one due row to only one competing discovery', async () => {
		await database.exec(
			`insert into bolt_task (command, input, effect_id) values
			 ('collections.resume', '{}', 'claim-once')`
		);
		const [left, right] = await Promise.all([queue().fire(Date.now()), queue().fire(Date.now())]);
		expect([...left.occurrences, ...right.occurrences]).toHaveLength(1);
		expect((await tasks())[0]).toMatchObject({ status: 'running', attempts: 1 });
	});

	it('does not double-claim a live lease and recovers it after expiry', async () => {
		await database.exec(
			`insert into bolt_task (command, input, effect_id) values
			 ('collections.discard', '{}', 'leased')`
		);
		const first = await queue().fire(Date.now());
		expect(first.occurrences[0]).toMatchObject({ taskId: 'leased', attempt: 1 });
		expect((await queue().fire(Date.now())).occurrences).toEqual([]);
		await database.exec(
			"update bolt_task set lease_expires_at = now() - interval '1 second' where effect_id = 'leased'"
		);
		expect((await queue().fire(Date.now())).occurrences[0]).toMatchObject({
			taskId: 'leased',
			attempt: 2
		});
	});

	it('retries retryable failures with bounded backoff and exhausts the row', async () => {
		await database.exec(
			`insert into bolt_task (command, input, effect_id, max_attempts) values
			 ('integrations.flush', '{}', 'retrying', 2)`
		);
		const first = (await queue().fire(Date.now())).occurrences[0]!;
		const before = Date.now();
		await queue().settle(
			first.taskId,
			first.attempt,
			{ _tag: 'Failed', error: 'provider unavailable', retryable: true },
			() => 0
		);
		const retrying = (await tasks())[0]!;
		expect(retrying).toMatchObject({
			status: 'pending',
			attempts: 1,
			error: 'provider unavailable'
		});
		// System instants are stored at second precision, so a five-second delay may lose <1s here.
		expect(new Date(String(retrying.run_at)).getTime()).toBeGreaterThanOrEqual(before + 4_000);
		expect(new Date(String(retrying.run_at)).getTime()).toBeLessThanOrEqual(before + 6_000);
		await database.exec("update bolt_task set run_at = now() - interval '1 second'");
		const second = (await queue().fire(Date.now())).occurrences[0]!;
		expect(second.attempt).toBe(2);
		await queue().settle(
			second.taskId,
			second.attempt,
			{ _tag: 'Failed', error: 'still unavailable', retryable: true },
			() => 0
		);
		expect((await tasks())[0]).toMatchObject({
			status: 'failed',
			attempts: 2,
			error: 'still unavailable'
		});
	});

	it('fails non-retryable work on its first attempt', async () => {
		await database.exec(
			`insert into bolt_task (command, input, effect_id) values
			 ('collections.resume', '{}', 'invalid')`
		);
		const occurrence = (await queue().fire(Date.now())).occurrences[0]!;
		await queue().settle(occurrence.taskId, occurrence.attempt, {
			_tag: 'Failed',
			error: 'invalid input',
			retryable: false
		});
		expect((await tasks())[0]).toMatchObject({ status: 'failed', attempts: 1 });
	});

	it('fences a late settlement from an expired attempt', async () => {
		await database.exec(
			`insert into bolt_task (command, input, effect_id) values
			 ('collections.resume', '{}', 'stale-settle')`
		);
		const first = (await queue().fire(Date.now())).occurrences[0]!;
		await database.exec("update bolt_task set lease_expires_at = now() - interval '1 second'");
		const second = (await queue().fire(Date.now())).occurrences[0]!;
		await queue().settle(first.taskId, first.attempt, { _tag: 'Done', result: 'stale' });
		expect((await tasks())[0]).toMatchObject({ status: 'running', attempts: 2, result: null });
		await queue().settle(second.taskId, second.attempt, { _tag: 'Done', result: 'current' });
		expect((await tasks())[0]).toMatchObject({ status: 'done', attempts: 2, result: 'current' });
	});

	it('stops pending or running work and preserves the terminal fence', async () => {
		await database.exec(
			`insert into bolt_task (command, input, effect_id) values
			 ('automations.a', '{}', 'pending-stop')`
		);
		await runStatements([stopStatement('pending-stop', 'automations.a')]);
		expect((await tasks())[0]).toMatchObject({ status: 'stopped', error: 'stopped' });

		await database.exec(
			`insert into bolt_task (command, input, effect_id) values
			 ('automations.b', '{}', 'running-stop')`
		);
		const occurrence = (await queue().fire(Date.now())).occurrences[0]!;
		await runStatements([stopStatement(occurrence.taskId, occurrence.command)]);
		await queue().settle(occurrence.taskId, occurrence.attempt, {
			_tag: 'Done',
			result: { ignored: true }
		});
		expect((await tasks()).find(({ effect_id }) => effect_id === 'running-stop')).toMatchObject({
			status: 'stopped',
			error: 'stopped',
			result: null
		});
	});

	it('recovery releases only expired leases and terminally fences exhausted ones', async () => {
		await database.exec(`insert into bolt_task
			(command, input, effect_id, status, attempts, max_attempts, lease_expires_at) values
			('automations.a', '{}', 'expired', 'running', 1, 3, now() - interval '1 second'),
			('automations.b', '{}', 'live', 'running', 1, 3, now() + interval '1 hour'),
			('automations.c', '{}', 'exhausted', 'running', 3, 3, now() - interval '1 second')`);
		await runStatements(recoverStatements());
		expect((await tasks()).find(({ effect_id }) => effect_id === 'expired')).toMatchObject({
			status: 'pending',
			error: 'host interrupted previous attempt'
		});
		expect((await tasks()).find(({ effect_id }) => effect_id === 'live')).toMatchObject({
			status: 'running'
		});
		expect((await tasks()).find(({ effect_id }) => effect_id === 'exhausted')).toMatchObject({
			status: 'failed',
			error: 'attempt budget exhausted after interrupted run'
		});
	});

	it('records overlap as terminal and ignores a late success', async () => {
		await database.exec(
			`insert into bolt_task (command, input, effect_id) values
			 ('automations.a', '{}', 'overlap')`
		);
		const occurrence = (await queue().fire(Date.now())).occurrences[0]!;
		await queue().settle(occurrence.taskId, occurrence.attempt, {
			_tag: 'Skipped',
			reason: 'overlap'
		});
		await queue().settle(occurrence.taskId, occurrence.attempt, {
			_tag: 'Done',
			result: { tooLate: true }
		});
		expect((await tasks())[0]).toMatchObject({
			status: 'skipped',
			error: 'overlap',
			result: null
		});
	});
});
