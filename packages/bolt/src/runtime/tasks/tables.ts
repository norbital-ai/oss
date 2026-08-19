import { integer, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * The two tables scheduled and background work is made of.
 *
 * They are declared as Drizzle tables for the same reason `identity/auth-tables.ts` is: the runner
 * composes every statement through `drizzle-orm/pg-proxy`, so the column names it reads and the
 * column names the plan creates come from one declaration rather than from a query builder on one
 * side and a hand-written DDL string on the other. `compiler/schema-plan.ts` renders the DDL, as it
 * does for every other `bolt_*` table.
 *
 * Two tables and no more, because there are exactly two questions: *what should happen, and when
 * next* (`bolt_schedule`), and *one thing that should happen once* (`bolt_task`). Cron does not
 * execute — it enqueues — so there is one runner rather than two mechanisms, and no third table
 * holding the seam between them.
 */

/**
 * What should happen, and when next.
 *
 * Six columns. There is deliberately no `active` flag: activation upserts the keys the release
 * declares and deletes the ones it does not, so "not declared" and "not active" cannot disagree.
 *
 * `crontab` is stored verbatim as authored rather than as a parsed form, so the operations panel can
 * show back the string a person wrote. `next_run_at` is the parsed form's only durable consequence,
 * and it is computed in the guest because the guest is the only party that can see what a release
 * declares.
 */
export const boltSchedule = pgTable(
	'bolt_schedule',
	{
		/**
		 * What this schedule is, in the terms the release declares it — `automations.rfi_followup_watch`
		 * or `integrations.pull:rfis.erp`. The key rather than a surrogate id because activation
		 * reconciles by it: a redeploy of the same automation must update its row, not append a second.
		 */
		key: text('key').primaryKey(),
		command: text('command').notNull(),
		crontab: text('crontab').notNull(),
		input: jsonb('input').notNull(),
		nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
		lastFiredAt: timestamp('last_fired_at', { withTimezone: true })
	},
	(table) => [index('bolt_schedule_due').on(table.nextRunAt)]
);

/**
 * One thing that should happen once.
 *
 * `run_at` does double duty, and that is the main simplification. It says when a task is due; taking
 * a task pushes it into the future, which is what "hidden while it runs" means. There is no lease
 * column, no `locked_by` and no `running` status — a task that was taken and never finished simply
 * becomes due again when the hide expires. One field, one concept, and crash recovery with no
 * reaper.
 *
 * `effect_id` is the only idempotency mechanism. An ordinary enqueue uses a key derived from the
 * caller's `EffectId`; a cron occurrence uses `schedule:<key>@<slot>`, so the unique index gives
 * exactly-once cron for free — two hosts that both notice the 06:00 slot both insert, and the index
 * picks the winner without either having to know the other existed.
 */
export const boltTask = pgTable(
	'bolt_task',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/** One of the names `dispatch.ts` already routes. Nothing here is a second command vocabulary. */
		command: text('command').notNull(),
		input: jsonb('input').notNull(),
		/**
		 * `pending` · `done` · `failed`, and no fourth.
		 *
		 * In particular there is no `running`: a taken row is a pending row whose `run_at` is in the
		 * future, so a run that dies leaves nothing to clean up.
		 */
		status: text('status').notNull().default('pending'),
		runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(8),
		effectId: text('effect_id').notNull().unique('bolt_task_effect_id'),
		result: jsonb('result'),
		/**
		 * A code and a short reason — never a body, never a header.
		 *
		 * The same rule `bolt_integration_outbox.last_error` is written under, for the same reason: a
		 * request header is where the credential is and a response body is where a partner's data is.
		 */
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// The only read `take` makes, and the only one it should be able to make. Partial, because a
		// table that has drained a year of work is almost entirely `done` and `failed`, and a full
		// index over `run_at` would have the runner walking that history on every tick.
		index('bolt_task_due')
			.on(table.runAt)
			.where(sql`status = 'pending'`)
	]
);

/** The schema handed to the proxy driver, keyed by the names the statements above address. */
export const taskSchema = { bolt_task: boltTask, bolt_schedule: boltSchedule };
