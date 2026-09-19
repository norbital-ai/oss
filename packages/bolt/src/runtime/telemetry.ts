import { Cause, Context, Effect, Exit, Logger, Option, Redacted, Schema } from 'effect';
import { lt, sql } from 'drizzle-orm';
import { EffectId, type Invocation } from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { HostConfig } from '#lib/runtime/access/system-principal.js';
import { composer, executeBuilt, transactionBuilt } from '#lib/runtime/persistence.js';

/**
 * How the runtime tells what it did, and keeps it.
 *
 * Every log the runtime writes inside an invocation is a record: an event name, a severity, the
 * ids that make it traceable end to end (tenant, environment, release, invocation, then
 * conversation and turn where there is one) and the event's own fields — the shape of an
 * OpenTelemetry log record. Two things happen to each: it goes to the console as one JSON line,
 * which is the channel a shipper reads from (bolt-server's stdout; the guest console Colony
 * bridges out of the isolate), and it is kept in the tenant's `telemetry` collection for the
 * window the host configures, so the person, the agent and Studio query it like any collection —
 * on the host Colony runs and on a host someone runs themselves, the same way, because the
 * runtime is what keeps it. The records of one invocation are written as one statement when it
 * ends, and each write prunes what has aged out of the window.
 *
 * Not spam: a record is a turn, a model call, a tool call, a checkpoint, a write, an automation
 * run, a warning, or a failure. Nothing logs "entering function".
 */
const TELEMETRY_RETAIN_HOURS_KEY = 'BOLT_TELEMETRY_RETAIN_HOURS';
const DEFAULT_RETAIN_HOURS = 72;
const LINE_LIMIT = 4_000;

type Row = typeof SYSTEM_MODEL_TABLES.telemetry.$inferInsert;

/**
 * The records of one invocation, gathered as they are logged and written in slices: every
 * `SLICE_ROWS` while the work runs (a turn can last a quarter of an hour, and its records are
 * worth reading while it does), and the rest when it ends.
 */
type Sink = { readonly invocation: Invocation; readonly rows: Array<Row>; slices: number };
export const makeSink = (invocation: Invocation): Sink => ({ invocation, rows: [], slices: 0 });
export const Sink = Context.Service<Sink>('@bolt/TelemetrySink');
const SLICE_ROWS = 100;

const ID_KEYS = new Set(['invocation', 'conversation', 'turn']);

const rowOf = (structured: {
	readonly level: string;
	readonly timestamp: string;
	readonly message: unknown;
	readonly cause: string | undefined;
	readonly annotations: Record<string, unknown>;
}): Row => {
	const attributes: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(structured.annotations))
		if (!ID_KEYS.has(key) && value !== undefined) attributes[key] = value;
	if (structured.cause !== undefined) attributes['cause'] = structured.cause.slice(0, LINE_LIMIT);
	const id = (key: string) =>
		typeof structured.annotations[key] === 'string'
			? (structured.annotations[key] as string)
			: null;
	return {
		at: structured.timestamp,
		severity: structured.level,
		event: String(structured.message).slice(0, 200),
		invocation: id('invocation'),
		conversation: id('conversation'),
		turn: id('turn'),
		attributes
	};
};

/** The console line for shippers, and the row for the window. */
export const loggerFor = (sink: Sink) =>
	Logger.layer([
		Logger.withConsoleLog(Logger.formatJson),
		Logger.map(Logger.formatStructured, (structured) => {
			sink.rows.push(rowOf(structured));
		})
	]);

/** The ids every record of one invocation carries. */
export const invocationAnnotations = (
	invocation: Invocation
): Readonly<Record<string, string | number>> => ({
	tenant: invocation.scope.tenantId,
	environment: invocation.scope.environment,
	release: invocation.scope.releaseId,
	invocation: invocation.id,
	kind: invocation._tag,
	...(invocation._tag === 'Command' || invocation._tag === 'Plugin'
		? { command: invocation.command }
		: {}),
	...(invocation._tag === 'Task' ? { task: invocation.taskId, attempt: invocation.attempt } : {})
});

/** One telemetry record: an event name and its measured fields, at info. */
export const record = (
	event: string,
	fields: Readonly<Record<string, string | number | boolean | null>>
): Effect.Effect<void> => Effect.logInfo(event).pipe(Effect.annotateLogs(fields));

/**
 * How the invocation ended: one record, at info with its time when it settled, at warning with the
 * reason when it refused, at error with the cause when it failed — surfaced as a record rather
 * than lost in a stack.
 */
export const recordSettled = (
	invocation: Invocation,
	startedAt: number,
	exit: Exit.Exit<unknown, unknown>
) => {
	const ms = Date.now() - startedAt;
	if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause))
		// Only the work the host asked for settles as a record. A health probe and a sync frame are
		// the chatter around it: they leave nothing unless they fail, or unless the work they carry
		// recorded something of its own.
		return invocation._tag === 'Request' || invocation._tag === 'Realtime'
			? Effect.void
			: record('dispatch.settled', {
					ms,
					outcome: Exit.isSuccess(exit) ? 'success' : 'interrupted'
				});
	// A typed failure is a refusal the runtime meant — a missing credential, a policy, a rule — and
	// its message is the whole story; a defect is the runtime's own fault and carries its stack.
	return Cause.hasDies(exit.cause)
		? Effect.logError('dispatch.failed').pipe(
				Effect.annotateLogs({ ms, error: Cause.pretty(exit.cause).slice(0, LINE_LIMIT) })
			)
		: Effect.logWarning('dispatch.refused').pipe(
				Effect.annotateLogs({ ms, error: String(Cause.squash(exit.cause)).slice(0, LINE_LIMIT) })
			);
};

const decodeHours = Schema.decodeUnknownOption(
	Schema.FiniteFromString.check(Schema.isGreaterThan(0))
);

/** The window, read from the host once per runtime: a config round trip per invocation is not it. */
let retainHoursMemo: number | undefined;
const retainHours = Effect.gen(function* () {
	if (retainHoursMemo !== undefined) return retainHoursMemo;
	const config = yield* Effect.serviceOption(HostConfig);
	const read = Option.isNone(config)
		? Option.none<Redacted.Redacted<string>>()
		: yield* config.value
				.read(TELEMETRY_RETAIN_HOURS_KEY)
				.pipe(Effect.orElseSucceed(() => Option.none()));
	retainHoursMemo = Option.getOrElse(
		Option.flatMap(read, (value) => decodeHours(Redacted.value(value))),
		() => DEFAULT_RETAIN_HOURS
	);
	return retainHoursMemo;
});

/**
 * Keep what the sink holds: one insert under its own effect id — an effect id is an idempotency
 * key, so each slice needs its own — and, when a task ends, the prune of what aged out. Runs
 * uninterruptibly: an interrupted invocation is the one whose records matter most. A failure here
 * is logged to the console and otherwise dropped — telemetry must never fail the work it describes.
 */
const flush = (sink: Sink, final: boolean) =>
	Effect.gen(function* () {
		if (sink.rows.length === 0) return;
		const { invocation } = sink;
		const database = yield* Database.Service;
		const table = SYSTEM_MODEL_TABLES.telemetry;
		const insert = composer.insert(table).values(sink.rows.splice(0));
		const effectId = EffectId.make(`${invocation.id}:telemetry:${(sink.slices += 1)}`);
		// A task — a turn, an automation run — carries the prune; a command stays one statement,
		// because a statement is what a tenant's database bills.
		if (!final || invocation._tag !== 'Task')
			return yield* executeBuilt(effectId, database, insert);
		const hours = yield* retainHours;
		yield* transactionBuilt(effectId, database, [
			insert,
			composer.delete(table).where(lt(table.at, sql`now() - make_interval(hours => ${hours})`))
		]);
	}).pipe(
		Effect.uninterruptible,
		Effect.catchCause((cause) =>
			Effect.sync(() => {
				console.error(
					`telemetry: records of ${sink.invocation.id} not kept: ${Cause.squash(cause)}`
				);
			})
		)
	);

/** The invocation's remaining records, when it ends. */
export const flushAll = (sink: Sink) => flush(sink, true);

/** A slice of records, when enough have gathered — for long work to call between its steps. */
export const keep = (database: Database.Interface): Effect.Effect<void> =>
	Effect.flatMap(Effect.serviceOption(Sink), (sink) =>
		Option.isSome(sink) && sink.value.rows.length >= SLICE_ROWS
			? flush(sink.value, false).pipe(Effect.provideService(Database.Service, database))
			: Effect.void
	);
