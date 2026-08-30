import { PGlite } from '@electric-sql/pglite';
import { Effect } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workspace } from '../../src/authoring/workspace-schema.js';
import { buildSchemaPlan } from '../../src/compiler/schema-plan.js';
import {
	makeQueue,
	recoverStatement,
	slotEffectId,
	stopStatement,
	type ExecuteStatements
} from '../../src/runtime/tasks/queue.js';

/**
 * The cron engine is exercised against real Postgres semantics. There is deliberately no fixture
 * here for claims, leases, retries, deferred work, or serial lanes: `bolt_task` is an observation
 * of one already-fired cron occurrence, not a durable execution queue.
 */
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
			step.id.startsWith('collection:bolt_task') ||
			step.id.startsWith('collection:bolt_schedule') ||
			step.id.startsWith('collection:bolt_sync_outbox') ||
			step.id.startsWith('collection:bolt_sync_horizon')
	);

const HOUR_MILLIS = 3_600_000;
const DAY_MILLIS = 24 * HOUR_MILLIS;
const at = (iso: string): number => Date.parse(iso);
const hourAt = (instant: number): number => Math.floor(instant / HOUR_MILLIS) * HOUR_MILLIS;
const nextDailySix = (instant: number): number => {
	const moment = new Date(instant);
	const today = Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate(), 6);
	return today > instant ? today : today + DAY_MILLIS;
};

describe('cron task observations over a host facility', () => {
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
			fire: (...args: Parameters<typeof effects.fire>) => Effect.runPromise(effects.fire(...args)),
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
				'select id, command, status, effect_id, error, result, run_at from bolt_task order by created_at, effect_id'
			)
		).rows;
	const schedules = async () =>
		(
			await database.query<Record<string, unknown>>(
				'select key, command, crontab, next_run_at, last_fired_at from bolt_schedule order by key'
			)
		).rows;

	it('applies the cron-only schema repeatedly', async () => {
		for (const step of taskSchemaSteps()) await database.exec(step.sql);
		const columns = await database.query<{ column_name: string }>(
			`select column_name from information_schema.columns
			 where table_name = 'bolt_task' order by column_name`
		);
		expect(columns.rows.map(({ column_name }) => column_name)).not.toEqual(
			expect.arrayContaining(['attempts', 'lane', 'max_attempts', 'position'])
		);
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

	it('advances one due schedule at fire time and records one running occurrence', async () => {
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
				scheduledForEpochMs: slot
			}
		]);
		expect((await tasks())[0]).toMatchObject({
			status: 'running',
			effect_id: slotEffectId('automations.digest', slot)
		});
		expect(new Date(String((await schedules())[0]?.next_run_at)).getTime()).toBe(
			nextDailySix(now)
		);
	});

	it('fires one missed occurrence and rejoins the current rhythm without replaying backlog', async () => {
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
		expect((await queue().fire(now)).occurrences).toHaveLength(1);
		expect((await queue().fire(now + 1_000)).occurrences).toHaveLength(0);
		expect(await tasks()).toHaveLength(1);
	});

	it('settles success and failure terminally and never creates retry work', async () => {
		const now = Date.now();
		await queue().declare(
			[
				{ key: 'a', command: 'automations.a', crontab: '* * * * *', input: {} },
				{ key: 'b', command: 'automations.b', crontab: '* * * * *', input: {} }
			],
			now
		);
		await database.exec("update bolt_schedule set next_run_at = now() - interval '1 second'");
		const fired = await queue().fire(now);
		const first = fired.occurrences[0];
		const second = fired.occurrences[1];
		if (first === undefined || second === undefined) throw new Error('expected two occurrences');
		await queue().settle(first.taskId, { _tag: 'Done', result: { delivered: 2 } });
		await queue().settle(second.taskId, { _tag: 'Failed', error: 'provider unavailable' });
		expect((await tasks()).map(({ status }) => status).toSorted()).toEqual(['done', 'failed']);
		expect(await queue().when()).toBeGreaterThan(now);
	});

	it('preserves a terminal stop against a late successful completion', async () => {
		const now = Date.now();
		await queue().declare(
			[{ key: 'a', command: 'automations.a', crontab: '* * * * *', input: {} }],
			now
		);
		await database.exec("update bolt_schedule set next_run_at = now() - interval '1 second'");
		const [task] = (await queue().fire(now)).occurrences;
		if (task === undefined) throw new Error('expected one occurrence');
		await runStatements([stopStatement(task.taskId, task.command)]);
		await queue().settle(task.taskId, { _tag: 'Done', result: { ignored: true } });
		expect((await tasks())[0]).toMatchObject({ status: 'stopped', error: 'stopped', result: null });
	});

	it('marks every in-flight cron occurrence failed on environment recovery', async () => {
		await database.exec(`insert into bolt_task (command, input, effect_id, status) values
			('automations.a', '{}', 'running-a', 'running'),
			('automations.b', '{}', 'done-b', 'done')`);
		await runStatements([recoverStatement()]);
		expect((await tasks()).find(({ effect_id }) => effect_id === 'running-a')).toMatchObject({
			status: 'failed',
			error: 'host restarted during run'
		});
		expect((await tasks()).find(({ effect_id }) => effect_id === 'done-b')?.status).toBe('done');
	});

	it('records an overlapping occurrence as skipped and never rewrites it later', async () => {
		const now = Date.now();
		await queue().declare(
			[{ key: 'a', command: 'automations.a', crontab: '* * * * *', input: {} }],
			now
		);
		await database.exec("update bolt_schedule set next_run_at = now() - interval '1 second'");
		const [occurrence] = (await queue().fire(now)).occurrences;
		if (occurrence === undefined) throw new Error('expected one occurrence');
		await queue().settle(occurrence.taskId, { _tag: 'Skipped', reason: 'overlap' });
		await queue().settle(occurrence.taskId, { _tag: 'Done', result: { tooLate: true } });
		expect((await tasks())[0]).toMatchObject({
			status: 'skipped',
			error: 'overlap',
			result: null
		});
	});
});
