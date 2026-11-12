// Durable attempt execution and settlement share one generation's stop and parking controls.
import { Clock, Deferred, Effect, Option, Predicate, PubSub, Random } from 'effect';
import { encode_wire } from '@norbital-ai/std/wire';
import type { EffectEvent } from '../../protocol/effect-events.ts';
import type { AutomationSpec } from '../../decl/runtime/automation.ts';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { exposed, viewOutput, type Holder } from '../access/authority.ts';
import { Audit } from '../audit.ts';
import { audited } from '../audit-operation.ts';
import { decodeAutomationInput } from '../callables/decode.ts';
import { decodeOutput } from '../callables/output.ts';
import type { Authority, GuestOutcome, RowData } from '../contracts.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { storedWireValue } from '../db/stored.ts';
import { catalog_of } from '../access/pred.ts';
import { CapturedResult, nativeCommit } from '../db/captured.ts';
import { DbError, is_transient } from '../errors.ts';
import type { EngineManifest } from '../manifest.ts';
import type { makeParking } from '../parking.ts';
import { RunUnits } from '../ports.ts';
import { Automations, Identity, Live, Manifest, RunEnds, RunHandlers, type RunHandler } from '../services.ts';
import { retryDelay } from '../queue.ts';
import { Chain } from '../write/sql.ts';
import type { RunAttempt } from './attempt.ts';
import { effectImages, EffectInput } from './input.ts';
import { QUEUED, type Ledger } from './ledger.ts';
import { PRUNE, type makePruner } from './prune.ts';
import { effectOf } from './queue.ts';
import { runPiece, type Row } from './rows.ts';
import { duration, due_at, iso } from './time.ts';

/**
 * Rule 54: a run retries a transient failure and a write that lost a race. The guest settles an act conflict as a
 * refusal with code `conflict`, so that one is read off the refusal.
 */
export const retriable = (outcome: GuestOutcome): boolean =>
	outcome.kind === 'failed'
		? is_transient(outcome.error)
		: outcome.kind === 'refused' && outcome.code === 'conflict';

/** A model effect's run: the writer's authority (`sys_run.starter`), retried 3 times; it holds no policy of its own. */
const EFFECT: Pick<AutomationSpec, 'description' | 'retry' | 'input' | 'output'> = {
	description: 'A model effect.',
	retry: { attempts: 3 }
};
type ExecutionSpec = EngineManifest['automations'][string] | typeof EFFECT;
/**
 * The holder an automation run is: the reserved system identity holding exactly its declared policies. Who started it
 * (`sys_run.trigger`) never enters its authority.
 */
const policyHolder = (head: Row, policies: readonly string[]): Holder => ({
	actor: { kind: 'system', run: head.id, by: { automation: head.automation } },
	policies,
	admin: false
});
/**
 * An effect's images as its writer reads them: the root fields of the writer's output of the model (`default` when it
 * holds it, else the first named output it holds, in declaration order); nothing when it holds none. The rows
 * themselves are the writer's own write, admitted by its grant.
 */
function writerInput(
	m: EngineManifest,
	a: Authority,
	model: string,
	input: typeof EffectInput.Type
): { readonly changes: Json; readonly event: EffectEvent } {
	const output = viewOutput(m, a, model);
	const keep = new Set(output === undefined ? [] : ['id', 'revision', ...exposed(m, model, model, model, output)]);
	// stored images keep int8 and numeric cells as exact text; the body reads them as the read compiler's wire values
	const columns = new Map([...(catalog_of(m).models.get(model)?.fields.values() ?? [])]
		.filter((field) => field.arms === undefined).map((field) => [field.column, field]));
	const shown = (image: RowData): RowData => Object.fromEntries(Object.entries(image)
		.filter(([field]) => a.admin || keep.has(field))
		.map(([column, value]) => {
			const field = columns.get(column);
			return [column, field === undefined ? value : storedWireValue(field, value) ?? value];
		}));
	const changes = !a.admin && output === undefined ? [] : input.changes.map((change) => ({
		before: change.before === null ? null : shown(change.before),
		set: shown(change.set),
		after: change.after === null ? null : shown(change.after)
	}));
	const event = input.event.kind === 'write' ? input.event : {
		...input.event,
		records: input.event.records.map((record) => ({
			id: record.id,
			row: record.row === null ? null : shown(record.row)
		}))
	};
	return { changes, event };
}
export const makeRunExecutor = Effect.fn('Runs.executor')(function* (
	parking: ReturnType<typeof makeParking>,
	halts: Map<string, Deferred.Deferred<void>>,
	stopping: Set<string>,
	prune: Effect.Success<ReturnType<typeof makePruner>>['prune']
) {
	const m = yield* Manifest, db = yield* TenantDb, audit = yield* Audit, live = yield* Live;
	const identity = yield* Identity, automations = yield* Automations, registry = yield* RunHandlers, ends = yield* RunEnds;
	const interrupted = Effect.fn('Runs.interrupted')(function* (rows: readonly Row[], message: string) {
			const c = new Chain();
			runPiece(c, 'interrupted', `UPDATE sys_run r SET error = ${c.p({ code: 'interrupted', message })}::jsonb
				WHERE r.state = 'running' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(${c.p(rows.map((row) => ({ id: row.id, attempts: row.attempts })))}::jsonb)
				AS x(id text, attempts int) WHERE x.id = r.id AND x.attempts = r.attempts)`);
			yield* nativeCommit(db.write, live.publish, c, CapturedResult);
		});
	const settle = Effect.fn('Runs.settle')(function* (
		rows: readonly Row[], head: Row, spec: ExecutionSpec | undefined,
		outcome: GuestOutcome, now: number, warnings: readonly string[]
	) {
		const platformRetry = yield* registry.retry(head.automation),
			policy = spec?.retry ?? Option.getOrUndefined(platformRetry);
		const retry = retriable(outcome) && head.attempts < (policy?.attempts ?? 1);
		const at = yield* Clock.currentTimeMillis,
			jitter = 0.5 + (yield* Random.next);
		const wait = retryDelay(head.attempts, duration(policy?.backoff ?? '10s'), 3_600_000, jitter),
			due = retry ? due_at(at, at + wait) : null;
		const state = retry ? 'queued' : outcome.kind === 'ok' ? 'succeeded' : 'failed';
		const error =
			outcome.kind === 'ok'
				? null
				: outcome.kind === 'refused'
					? {
							code: outcome.code ?? 'refused',
							message: outcome.message,
							...(outcome.field === undefined ? {} : { field: outcome.field }),
							...(outcome.row === undefined ? {} : { row: outcome.row }),
							...(outcome.rows === undefined ? {} : { rows: outcome.rows }),
							...(outcome.rule === undefined ? {} : { rule: outcome.rule }),
							...(outcome.data === undefined ? {} : { data: outcome.data }),
							...(outcome.records === undefined ? {} : { records: outcome.records }),
							...(outcome.invocation === undefined ? {} : { invocation: outcome.invocation })
						}
					: {
						code: outcome.error.code,
						message: outcome.error.message,
						...(outcome.error.cause instanceof DbError ? {
							sqlstate: outcome.error.cause.sqlstate,
							...(outcome.error.cause.outcome_unknown === true ? { outcome_unknown: outcome.error.cause.outcome_unknown } : {})
						} : {})
					};
		const result: RunAttempt = {
			attempt: head.attempts,
			at: iso(at),
			state,
			...(outcome.kind === 'ok' ? { output: outcome.output } : error === null ? {} : { error }),
			...(warnings.length === 0 ? {} : { warnings }),
			...(head.cause === 'cron' && now - Date.parse(head.due_at) > 60_000
				? { missed: true }
				: {})
		};
		const c = new Chain();
		runPiece(c,
			'done',
			`UPDATE sys_run s SET state = ${c.p(state)}, output = ${c.p(outcome.kind === 'ok' ? JSON.stringify(outcome.output) : null)}::jsonb, error = ${c.p(error)}::jsonb, finished_at = ${state === 'queued' ? 'NULL' : `${c.p(iso(at))}::timestamptz`}, due_at = coalesce(${c.p(due === null ? null : iso(due))}::timestamptz, s.due_at), results = s.results || jsonb_build_array(${c.p(result)}::jsonb) WHERE s.id IN (SELECT jsonb_array_elements_text(${c.p(rows.map((row) => row.id))}::jsonb)) AND s.state <> 'stopped'`
		);
		const committed = yield* audited(
			db,
			{
				category: 'automation',
				action: `${head.automation}.finish`,
				actor: { kind: 'system', id: head.id, label: null },
				run: head.id,
				payload: encode_wire({
					automation: head.automation,
					runIds: rows.map((row) => row.id),
					result
				})
			},
			nativeCommit(db.write, live.publish, c, CapturedResult).pipe(Effect.map((answer) => answer.captured.map((row) => row.id)))
		).pipe(Effect.provideService(Audit, audit));
		if (state !== 'queued')
			yield* PubSub.publish(
				ends,
				committed
			);
		return due;
	});
	const execute = Effect.fn('Runs.execute')(function* (rows: readonly Row[], ledger: Ledger = QUEUED) {
			const head = rows[0];
			if (head === undefined) return [];
			yield* (yield* RunUnits).next();
			const now = yield* Clock.currentTimeMillis,
				effect = effectOf(m, head.automation),
				spec = m.automations[head.automation] ?? (effect === undefined ? undefined : EFFECT),
				dues: number[] = [],
				warnings: string[] = [];
			if (spec !== undefined) parking.enter(head.id);
			let input: Json = head.input;
			const decoded = spec?.input === undefined ? undefined : decodeAutomationInput(spec.input, input);
			let outcome: GuestOutcome;
			const handler =
				head.automation === PRUNE
					? Option.some<RunHandler>(() =>
							prune(now).pipe(Effect.map((result): Json => ({ ...result })))
						)
					: yield* registry.handler(head.automation);
			if (spec === undefined && Option.isSome(handler)) {
				// Platform handlers own their I/O and page statements, so claim a fired slot before handing them control.
				// A queued attempt already has its lease; a repeated cron slot must never enter the handler again.
				if (!ledger.written() && !(yield* ledger.record)) return dues;
				outcome = yield* handler.value(input, head).pipe(
					Effect.map((output): GuestOutcome => ({ kind: 'ok', output })),
					Effect.catch((error) =>
						Effect.succeed({
							kind: 'failed',
							error:
								error._tag === 'BoltError'
									? error
									: BoltError.make(is_transient(error) ? 'upstream' : 'internal', 'guest', error.message, error)
						} satisfies GuestOutcome)
					)
				);
			} else if (spec === undefined)
				outcome = {
					kind: 'failed',
					error: BoltError.make(
						'unknown_automation',
						'admission',
						`no automation '${head.automation}'`
					)
				};
			else if (decoded !== undefined && decoded.problems.length > 0)
				outcome = {
					kind: 'failed',
					error: BoltError.make('invalid_input', 'decode', 'The run input did not decode.')
				};
			else {
				if (decoded?.value !== undefined) input = encode_wire(decoded.value);
				// an effect runs as its writer; an automation as the system identity with its policies
				const automation = m.automations[head.automation];
				const holder: Holder | undefined =
					automation === undefined
						? (head.starter ?? undefined)
						: policyHolder(head, automation.policies);
				const images = effect === undefined ? undefined : effectImages(input);
				if (holder === undefined)
					outcome = {
						kind: 'failed',
						error: BoltError.make('no_trigger', 'admission', 'the run has no starter')
					};
				else if (images !== undefined && Option.isNone(images))
					outcome = {
						kind: 'failed',
						error: BoltError.make(
							'invalid_input',
							'decode',
							'The effect run input did not decode.'
						)
					};
				else {
					let event: EffectEvent | undefined;
					// an effect's images as its writer reads them, handed over as the body's first argument
					if (effect !== undefined && images !== undefined && Option.isSome(images)) {
						const shown = writerInput(
							m,
							yield* identity.authority(holder),
							effect.model,
							images.value
						);
						input = shown.changes;
						event = shown.event;
					}
					const halt = yield* Deferred.make<void>();
					halts.set(head.id, halt);
					outcome = yield* automations.invoke(head, holder, input, {
						...(event === undefined ? {} : { event }),
						ids: rows.map((row) => row.id), record: ledger.record, halt,
						stopped: () => stopping.has(head.id), stop: () => stopping.add(head.id), dues, warnings
					}).pipe(Effect.ensuring(Effect.sync(() => halts.delete(head.id))));
				}
			}
			if (outcome.kind === 'ok' && spec !== undefined) {
				const decoded = yield* Effect.result(decodeOutput(m, spec.output, outcome.output));
				outcome =
					decoded._tag === 'Success'
						? { ...outcome, output: decoded.success }
						: { kind: 'failed', error: decoded.failure };
			}
			if (outcome.kind === 'failed' && outcome.error.code === 'interrupted') {
				yield* interrupted(rows, outcome.error.message);
				return dues;
			}
			if (!ledger.written()) {
				// An authored cron that only read writes nothing; platform handlers claimed their slot before I/O.
				const idle =
					outcome.kind === 'ok' &&
					(spec !== undefined ||
						(Predicate.isObject(outcome.output) && outcome.output['pages'] === 0));
				if (idle || !(yield* ledger.record)) return dues;
			}
			const due = yield* settle(rows, head, spec, outcome, now, warnings);
			if (due !== null) dues.push(due);
			return dues;
		}, (effect, rows, _ledger?: Ledger) => effect.pipe(
			Effect.onInterrupt(() =>
				interrupted(rows, 'The run was interrupted while its generation was draining (rule 71a).')
			),
			Effect.ensuring(
				Effect.sync(() => {
					for (const row of rows) stopping.delete(row.id);
					const head = rows[0];
					if (head !== undefined) parking.leave(head.id);
				})
			)
		));
	return { execute, interrupted };
});
