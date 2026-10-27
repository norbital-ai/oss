// Native, bounded interactive transactions. Only model reads and generated writes enter the leased connection.
import { Effect, Exit, Result, Schema, Scope } from 'effect';
import {
	canonical,
	sha256Hex,
	type Catalog,
	type ConstraintMeta,
	type Pred,
	type SelectIR
} from '@norbital-ai/store';
import { encodeWire } from '@norbital-ai/std/wire';
import { BoltError } from '../protocol/errors.ts';
import { WriteOutcome } from '../protocol/schema.ts';
import type { ReadIR } from '../protocol/reads.ts';
import type { Json } from '../decl/values.ts';
import type { Authority, Bindings, Captured, Lock, Outcome, Sql } from './contracts.ts';
import { LIMITS } from './contracts.ts';
import { DbError, type EngineError } from './errors.ts';
import { SqlSessionDb, type DbSession, type TenantDbShape } from './db/tenant-db.ts';
import { copiedSql } from './db/wire.ts';
import type { EngineManifest } from './manifest.ts';
import type { ActResult, Callable, ReadsShape, WritesShape } from './services.ts';
import { ReadDeps } from './query/engine.ts';
import { transactionApproval } from './approvals/transaction.ts';
import { constraintsOf, type StepsSnapshot } from './write/act.ts';
import {
	CommitAnswer,
	CommitStage,
	executeCommit,
	transactionEffects,
	type Commit,
	type CommitPublisher,
	type CommitStageShape
} from './write/commit.ts';
import {
	answer,
	Chain,
	decided,
	fingerprintAsserts,
	gate,
	storedOutcome,
	type ReadGuards
} from './write/sql.ts';
import { nextDue } from './runs/queue.ts';
import { prepareAudit, auditActor, settleAudit } from './audit-operation.ts';
import { Audit, type AuditShape } from './audit.ts';
import { auditContextSql, auditReceiptSql, type AuditMutation } from './audit-context.ts';

type Begin = { readonly key: string; readonly issuedAt: string; readonly readGuards?: ReadGuards };
type BeginAnswer =
	{ readonly cached: false } | { readonly cached: true; readonly outcome: Outcome };
type TransactionAct = {
	readonly callable: Extract<Callable, { readonly _tag: 'Verb' }>;
	readonly input: Json;
	readonly onConflict?: 'update' | 'keep';
};
export type TransactionController = {
	readonly begin: (input: Begin) => Effect.Effect<BeginAnswer, EngineError>;
	readonly read: (
		reads: readonly ReadIR[],
		keys?: readonly string[]
	) => Effect.Effect<Json, EngineError>;
	readonly act: (input: TransactionAct) => Effect.Effect<Json, EngineError>;
	readonly finish: (input: {
		readonly output: Json;
		readonly omitted: boolean;
	}) => Effect.Effect<ActResult, EngineError>;
	readonly abort: () => Effect.Effect<void, EngineError>;
};
type Config = {
	readonly audit?: AuditShape;
	readonly db: TenantDbShape;
	readonly manifest: EngineManifest;
	readonly reads: ReadsShape;
	readonly writes: WritesShape;
	readonly authority: Authority;
	readonly authorityForVerb: (name: string) => Authority;
	readonly bindings: Bindings;
	readonly sourceEpoch: string;
	readonly invocationId: string;
	readonly input?: Json;
};
type Held = {
	snapshot: StepsSnapshot;
	root: { model: string; id: string; op: 'create' | 'update' | 'delete' };
};
type Session = {
	audit: AuditMutation;
	committing: boolean;
	lease: DbSession;
	scope: Scope.Closeable;
	key: string;
	digest: string;
	issuedAt: string;
	invocation: string;
	guards: ReadGuards | undefined;
	steps: number;
	stageKeys: string[];
	captured: Captured[];
	capturedBytes: number;
	operations: number;
	readSql: Map<string, Sql>;
	tables: Set<string>;
	held: Held | undefined;
	publish: CommitPublisher | undefined;
};

/** Only an uncertain COMMIT becomes unknown. Known SQL conflicts and refusals retain their native failure family. */
export function transactionFailure(
	error: EngineError,
	invocation: string,
	constraints: ReadonlyMap<string, ConstraintMeta> = new Map()
): Outcome {
	if (error._tag === 'Conflict') return { kind: 'conflict', records: error.records };
	if (error._tag === 'SerializationReplay') return { kind: 'conflict', records: [] };
	if (error instanceof DbError) {
		if (error.sqlstate === '08007') return { kind: 'unknown', invocation };
		if (error.sqlstate === '57014' || error.sqlstate === '25P04' || error.sqlstate === '55P03')
			return { kind: 'refused', code: 'timeout', message: error.message };
		if (error.sqlstate === '54000')
			return { kind: 'refused', code: 'readBudgetExceeded', message: error.message };
		if (error.sqlstate === '0A000')
			return { kind: 'refused', code: 'unsupported', message: error.message };
		try {
			return decided(error, constraints).outcome;
		} catch {
			return { kind: 'refused', code: 'internal', message: error.message };
		}
	}
	if (error instanceof BoltError) {
		if (error.cause instanceof DbError)
			return transactionFailure(error.cause, invocation, constraints);
		if (error.code === 'conflict') return { kind: 'conflict', records: [] };
		return {
			kind: 'refused',
			code:
				error.code === 'timeout'
					? 'timeout'
					: error.code === 'unsupported'
						? 'unsupported'
						: error.code === 'approvalSplit'
							? 'approvalSplit'
							: error.code === 'forbidden'
								? 'forbidden'
								: error.code === 'sourceChanged'
									? 'sourceChanged'
									: error.code === 'locked'
										? 'locked'
										: error.code === 'readBudgetExceeded'
											? 'readBudgetExceeded'
											: 'invalidInput',
			message: error.message
		};
	}
	return { kind: 'refused', code: 'internal', message: error.message };
}

function hasSimilar(pred: Pred | undefined): boolean {
	if (pred === undefined) return false;
	if (pred.t === 'similar') return true;
	if (pred.t === 'and' || pred.t === 'or') return pred.of.some(hasSimilar);
	if (pred.t === 'not') return hasSimilar(pred.of);
	if (pred.t === 'one' || pred.t === 'many' || pred.t === 'each') return hasSimilar(pred.pred);
	return false;
}
function selectedSimilar(select: SelectIR): boolean {
	return Object.values(select.relations).some(
		(relation) =>
			hasSimilar(relation.where) ||
			selectedSimilar(relation.select) ||
			Object.values(relation.targetSelects ?? {}).some(selectedSimilar)
	);
}
function nativeRead(read: ReadIR): boolean {
	if (read.kind !== 'get' && read.kind !== 'read') return false;
	return (
		!selectedSimilar(read.select) &&
		(read.kind === 'get' || (read.search === undefined && !hasSimilar(read.where)))
	);
}

/** Collapse repeated row changes for the outer receipt and outbox while preserving every staged history revision. */
function netChanges(captured: readonly Captured[]): readonly Captured[] {
	const rows = new Map<string, Captured>();
	for (const row of captured) {
		const key = `${row.model}/${row.id}`,
			first = rows.get(key);
		rows.set(
			key,
			first === undefined
				? row
				: {
						...row,
						old: first.old,
						op: first.old === null ? 'create' : row.new === null ? 'delete' : 'update',
						cause: first.cause === 'direct' || row.cause === 'direct' ? 'direct' : row.cause
					}
		);
	}
	return [...rows.values()].filter((row) => row.old !== null || row.new !== null);
}

export const makeTransactions = (
	config: Config
): Effect.Effect<TransactionController, never, Scope.Scope> =>
	Effect.gen(function* () {
		const auditService = config.audit ?? (yield* Audit);
		let active: Session | undefined;
		let opening = false;
		const nativeTables = new Set([
			...Object.keys(config.manifest.models),
			'bolt_schema',
			'bolt_history',
			'bolt_seq',
			'bolt_idem',
			'bolt_idem_outcome',
			'bolt_rate',
			'bolt_push_subscriptions',
			'bolt_host_nonce',
			'bolt_credential',
			'bolt_approvals',
			'bolt_run_admitted'
		]);
		const required = () =>
			Effect.suspend(() =>
				active === undefined || opening
					? Effect.fail(
							BoltError.make('invalidInput', 'admission', 'No native transaction is open.')
						)
					: Effect.succeed(active)
			);
		const abort = (): Effect.Effect<void, EngineError> =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					const state = active;
					active = undefined;
					if (state === undefined) return;
					yield* state.lease.rollback.pipe(Effect.ensuring(Scope.close(state.scope, Exit.void)));
					if (!state.committing)
						yield* auditService
							.append([
								{
									...state.audit.event,
									id: `${state.audit.event.operationId}:terminal`,
									status: 'failed',
									payload: encodeWire({
										request: state.audit.event.payload,
										reason: 'The transaction rolled back before COMMIT.',
										proposed: state.captured
									})
								}
							])
							.pipe(Effect.catch((error) => Effect.logWarning(error)));
				})
			);
		yield* Effect.addFinalizer(() => abort().pipe(Effect.ignore));
		const stored = (key: string, digest: string) =>
			config.db.value(Schema.NullOr(WriteOutcome), {
				text: `SELECT ${storedOutcome('$1', '$2')} AS outcome`,
				params: [key, digest]
			});
		const stage: CommitStageShape = {
			execute: Effect.fn('Bolt.transactionStage')(function* (
				db: TenantDbShape,
				manifest: EngineManifest,
				catalog: Catalog,
				commit: Commit,
				lock?: Lock
			) {
				const state = yield* required();
				if (commit.resubmit !== undefined)
					return yield* BoltError.make(
						'locked',
						'admission',
						'An interactive transaction cannot resubmit an existing approval request.'
					);
				if (commit.approval !== undefined) {
					if (
						state.held !== undefined &&
						canonical(state.held.snapshot) !== canonical(commit.approval.route)
					)
						return yield* BoltError.make(
							'approvalSplit',
							'admission',
							'All writes in one transaction must use the same approval route.'
						);
					const root = commit.writes[0];
					if (root === undefined)
						return yield* BoltError.make(
							'invalidInput',
							'admission',
							'An approval transaction must change a record.'
						);
					state.held ??= {
						snapshot: commit.approval.route,
						root: { model: root.model, id: root.id, op: root.op }
					};
				}
				const { approval: _approval, ...ordinary } = commit;
				const rows = yield* executeCommit(
					db,
					manifest,
					catalog,
					{ ...ordinary, transactionStage: true },
					lock
				).pipe(Effect.provideService(CommitStage, undefined));
				for (const row of rows) {
					const bytes = new TextEncoder().encode(canonical(row.captured)).length;
					if (
						state.captured.length + row.captured.length > LIMITS.changesPerAct ||
						state.capturedBytes + bytes > LIMITS.readBytes
					)
						return yield* BoltError.make(
							'tooLarge',
							'admission',
							'The transaction cumulative row/byte budget was exceeded.'
						);
					state.capturedBytes += bytes;
					state.captured.push(...row.captured);
				}
				state.stageKeys.push(commit.key);
				return rows;
			}),
			publisher: (publish) => {
				if (active !== undefined) active.publish = publish;
			}
		};
		const bound = <A, E, R>(state: Session, effect: Effect.Effect<A, E, R>) => {
			const db: DbSession['db'] = {
				...state.lease.db,
				read: Effect.fn('Bolt.transactionReadSql')(function* (statements: readonly Sql[]) {
					const copied = yield* Effect.try({
						try: () => Array.from(statements, copiedSql),
						catch: (error) => DbError.make('22023', String(error))
					});
					const next = new Map(state.readSql);
					for (const sql of copied) {
						next.set(canonical(sql), sql);
						for (const match of sql.text.matchAll(
							/\b(?:FROM|JOIN)\s+(?:"((?:[^"]|"")*)"|([a-z_][a-z0-9_]*))/gi
						)) {
							const table =
								match[1] === undefined ? match[2]?.toLowerCase() : match[1].replaceAll('""', '"');
							if (table !== undefined && nativeTables.has(table)) state.tables.add(table);
						}
					}
					if (
						next.size > LIMITS.readGuards.count ||
						new TextEncoder().encode(canonical([...next.values()])).length > LIMITS.readGuards.bytes
					)
						return yield* DbError.make('54000', 'The transaction read guard budget was exceeded.');
					const rows = yield* state.lease.db.read(copied);
					state.readSql = next;
					return rows;
				})
			};
			return effect.pipe(
				Effect.provideService(SqlSessionDb, db),
				Effect.provideService(ReadDeps, state.tables),
				Effect.provideService(CommitStage, stage)
			);
		};
		const begin: TransactionController['begin'] = (input) => {
			let ownsOpening = false;
			return Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					if (active !== undefined || opening)
						return yield* BoltError.make(
							'invalidInput',
							'admission',
							'A native transaction is already open.'
						);
					ownsOpening = true;
					opening = true;
					const key = sha256Hex(
						canonical({ actor: config.authority.actor, callable: 'transaction', key: input.key })
					);
					const digest = sha256Hex(canonical({ sourceEpoch: config.sourceEpoch, key: input.key }));
					const previous = yield* restore(stored(key, digest));
					if (previous !== null) return { cached: true, outcome: previous };
					const audit = yield* prepareAudit({
						category: 'write',
						action: 'transaction',
						actor: auditActor(config.authority.actor),
						invocation: input.key,
						transaction: input.key,
						run: config.invocationId,
						outcomeKey: key,
						digest,
						payload: encodeWire({ input: config.input ?? null })
					}).pipe(Effect.provideService(Audit, auditService));
					const scope = yield* Scope.make();
					const lease = yield* restore(config.db.session().pipe(Scope.provide(scope))).pipe(
						Effect.onError(() => Scope.close(scope, Exit.void))
					);
					const state: Session = {
						audit,
						committing: false,
						lease,
						scope,
						key,
						digest,
						issuedAt: input.issuedAt,
						invocation: input.key,
						guards: input.readGuards,
						steps: 0,
						stageKeys: [],
						captured: [],
						capturedBytes: 0,
						operations: 0,
						readSql: new Map(),
						tables: new Set(input.readGuards?.tables ?? []),
						held: undefined,
						publish: undefined
					};
					active = state;
					return yield* restore(
						Effect.gen(function* (): Effect.fn.Return<BeginAnswer, EngineError> {
							yield* lease.db.write(auditContextSql(audit));
							if (
								input.readGuards?.sourceEpoch !== undefined &&
								input.readGuards.sourceEpoch !== config.sourceEpoch
							)
								return yield* BoltError.make(
									'sourceChanged',
									'admission',
									'The source changed after the transaction inputs were read.'
								);
							if (input.readGuards?.inconsistent === true)
								return yield* BoltError.make(
									'conflict',
									'admission',
									'The transaction inputs contain a changed repeated read.'
								);
							const c = new Chain();
							gate(c, key, digest, input.issuedAt);
							fingerprintAsserts(c, input.readGuards?.fingerprints ?? []);
							const rows = yield* config.db
								.returning(
									Schema.Struct({ fresh: Schema.Boolean }),
									c.sql('EXISTS (SELECT 1 FROM idem) AS fresh'),
									{
										advisory: [`bolt:transaction:${key}`],
										tables: [...state.tables].sort(),
										mode: 'SHARE ROW EXCLUSIVE'
									}
								)
								.pipe(Effect.provideService(SqlSessionDb, lease.db));
							if (rows[0]?.fresh !== true) {
								const outcome = yield* stored(key, digest).pipe(
									Effect.provideService(SqlSessionDb, lease.db)
								);
								yield* abort();
								if (outcome === null)
									return yield* BoltError.make(
										'conflict',
										'admission',
										'The transaction receipt is still being settled.'
									);
								return { cached: true, outcome };
							}
							return { cached: false };
						})
					).pipe(Effect.onError(() => abort().pipe(Effect.ignore)));
				})
			).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						if (ownsOpening) opening = false;
					})
				)
			);
		};
		const read: TransactionController['read'] = (reads, keys) =>
			Effect.gen(function* () {
				const state = yield* required();
				if (++state.operations > LIMITS.crossings.automation)
					return yield* BoltError.make(
						'crossingBudget',
						'admission',
						'The transaction operation budget was exceeded.'
					);
				if (reads.some((read) => !nativeRead(read)))
					return yield* BoltError.make(
						'invalidInput',
						'admission',
						'A transaction reads native records and lists only.'
					);
				if (keys !== undefined && keys.length !== reads.length)
					return yield* BoltError.make(
						'invalidInput',
						'admission',
						'The transaction query keys do not match its reads.'
					);
				const values = yield* bound(
					state,
					config.reads.run(reads, { as: 'caller', authority: config.authority }, config.bindings)
				);
				return keys === undefined
					? (values[0] ?? null)
					: Object.fromEntries(keys.map((key, index) => [key, values[index] ?? null]));
			}).pipe(Effect.onError(() => abort().pipe(Effect.ignore)));
		const act: TransactionController['act'] = (input) =>
			Effect.gen(function* () {
				const state = yield* required();
				if (++state.operations > LIMITS.crossings.automation)
					return yield* BoltError.make(
						'crossingBudget',
						'admission',
						'The transaction operation budget was exceeded.'
					);
				const callable = input.callable;
				if (!['create', 'update', 'delete', 'upsert'].includes(callable.verb))
					return yield* BoltError.make(
						'invalidInput',
						'admission',
						'A transaction writes generated create, update, delete and upsert only.'
					);
				const ordinal = state.steps++;
				const key = `${state.key}/${ordinal}`;
				const result = yield* bound(
					state,
					config.writes.act({
						model: callable.model,
						verb: callable.verb,
						input: input.input,
						mode: { _tag: 'Direct' },
						key,
						issuedAt: state.issuedAt,
						authority: config.authorityForVerb(`${callable.model}.${callable.verb}`),
						bindings: config.bindings,
						invocationId: key,
						...(input.onConflict === undefined ? {} : { onConflict: input.onConflict })
					})
				);
				if (result.outcome.kind !== 'committed') {
					yield* abort();
					return encodeWire(result.outcome);
				}
				return { output: result.outcome.output, records: encodeWire(result.outcome.records) };
			}).pipe(Effect.onError(() => abort().pipe(Effect.ignore)));
		const finish: TransactionController['finish'] = (input) =>
			Effect.gen(function* () {
				const state = yield* required();
				const result = yield* Effect.result(
					bound(
						state,
						Effect.gen(function* () {
							if (state.stageKeys.length > 0)
								yield* config.db.write({
									text: 'DELETE FROM bolt_idem WHERE key IN (SELECT jsonb_array_elements_text($1::jsonb))',
									params: [state.stageKeys]
								});
							const captures = netChanges(state.captured);
							const records = captures
								.filter((row) => row.cause === 'direct')
								.map(({ model, id, revision }) => ({ model, id, revision }));
							let outcome: Outcome = {
								kind: 'committed',
								output: { value: input.output, omitted: input.omitted },
								records
							};
							let heldAnswer: CommitAnswer | undefined;
							if (state.held !== undefined) {
								const sql = new Map<string, Sql>();
								for (const fingerprint of state.guards?.fingerprints ?? [])
									sql.set(canonical(fingerprint.sql), fingerprint.sql);
								for (const [key, value] of state.readSql) sql.set(key, value);
								if (
									sql.size > LIMITS.readGuards.count ||
									new TextEncoder().encode(canonical([...sql.values()])).length >
										LIMITS.readGuards.bytes
								)
									return yield* BoltError.make(
										'readBudgetExceeded',
										'admission',
										'The combined transaction approval read budget was exceeded.'
									);
								const guards: ReadGuards = {
									sourceEpoch: config.sourceEpoch,
									tables: [...state.tables].sort(),
									fingerprints: [...sql.values()].map((sql) => ({ sql, digest: '' }))
								};
								const held = yield* transactionApproval(config.manifest, config.db, {
									route: state.held.snapshot,
									root: state.held.root,
									captured: state.captured,
									authority: config.authority,
									bindings: config.bindings,
									seed: state.key,
									sourceEpoch: config.sourceEpoch,
									readGuards: guards
								});
								heldAnswer = held.answer;
								outcome = { kind: 'pendingApproval', requestId: held.requestId, records };
							}
							const c = new Chain();
							c.cte(
								'idem',
								`SELECT key FROM bolt_idem WHERE key=${c.p(state.key)} AND digest=${c.p(state.digest)} FOR UPDATE`
							);
							transactionEffects(
								config.manifest,
								c,
								config.bindings.now,
								config.authority.actor,
								captures,
								state.held !== undefined
							);
							const receipt = c.sql(
								`${answer(c, state.key, state.digest, `${c.p(encodeWire(outcome))}::jsonb`)}, '[]'::jsonb AS captured, ${nextDue(c)} AS next_due, '[]'::jsonb AS changed_instances`
							);
							const rows = yield* config.db.returning(CommitAnswer, receipt);
							const row = rows[0];
							if (row === undefined)
								return yield* BoltError.make(
									'badAnswer',
									'commit',
									'The transaction returned no receipt.'
								);
							return {
								outcome,
								answer: {
									...row,
									captured: captures,
									next_due:
										[row.next_due, heldAnswer?.next_due]
											.filter((value): value is string => typeof value === 'string')
											.sort()[0] ?? null,
									changed_instances: captures
										.filter((row) => row.model === 'sys_integration')
										.map((row) => row.id)
								}
							};
						})
					)
				);
				if (Result.isFailure(result)) {
					yield* abort().pipe(Effect.ignore);
					return {
						outcome: transactionFailure(
							result.failure,
							state.invocation,
							constraintsOf(config.manifest)
						),
						captured: [],
						v: 0
					};
				}
				yield* state.lease.db.write(auditReceiptSql(state.audit));
				state.committing = true;
				const committed = yield* Effect.result(state.lease.commit);
				active = undefined;
				yield* Scope.close(state.scope, Exit.void);
				yield* settleAudit(config.db, state.audit.event).pipe(
					Effect.provideService(Audit, auditService),
					Effect.catch((error) => Effect.logWarning(error))
				);
				if (Result.isFailure(committed))
					return {
						outcome: transactionFailure(
							committed.failure,
							state.invocation,
							constraintsOf(config.manifest)
						),
						captured: [],
						v: 0
					};
				const settled = result.success;
				const v =
					state.publish === undefined ? 0 : yield* state.publish(settled.answer, settled.outcome);
				return {
					outcome: settled.outcome,
					captured: settled.answer.captured,
					v,
					...(state.guards === undefined ? {} : { readGuardsConsumed: true as const })
				};
			});
		return { begin, read, act, finish, abort };
	});
