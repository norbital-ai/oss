import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import * as Workspace from '#lib/runtime/workspace.js';

export const ApprovalState = Schema.TaggedUnion({
	Pending: {
		requestId: Schema.NonEmptyString,
		step: Schema.Number.check(Schema.isInt()),
		operation: Schema.Json
	},
	Approved: {
		requestId: Schema.NonEmptyString,
		decidedBy: Schema.NonEmptyString,
		operation: Schema.optionalKey(Schema.Json)
	},
	// The two terminal refusals carry the operation for the same reason `Approved` does: the record
	// was already written when the request was opened, and it is still locked. Without the operation
	// there is no way back to the row, so the lock outlived every decision that was not an approval —
	// and since a workspace's liveness predicate is `approval_id is null`, a rejected record
	// stayed invisible and could not be deleted either.
	Rejected: {
		requestId: Schema.NonEmptyString,
		decidedBy: Schema.NonEmptyString,
		reason: Schema.String,
		operation: Schema.optionalKey(Schema.Json)
	},
	Withdrawn: {
		requestId: Schema.NonEmptyString,
		withdrawnBy: Schema.NonEmptyString,
		operation: Schema.optionalKey(Schema.Json)
	}
});
export type ApprovalState = typeof ApprovalState.Type;

/** The `approval_request.status` vocabulary authored reports filter on. */
const APPROVAL_STATUS: Readonly<Record<ApprovalState['_tag'], string>> = {
	Pending: 'ONGOING',
	Approved: 'APPROVED',
	Rejected: 'REJECTED',
	Withdrawn: 'WITHDRAWN'
};

const ApprovalTimelineEvent = Schema.Struct({
	kind: Schema.NonEmptyString,
	subjectId: Schema.NonEmptyString,
	payload: Schema.Json
});
export interface ApprovalTimelineEvent extends Schema.Schema.Type<typeof ApprovalTimelineEvent> {}

const ApprovalConfiguration = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	steps: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			name: Schema.NonEmptyString,
			approvers: Schema.Array(Schema.NonEmptyString),
			description: Schema.optionalKey(Schema.String)
		})
	)
});
const JsonObject = Schema.Record(Schema.String, Schema.Json);

/** The `JsonObject` predicate, built once: it is consulted for every operation value crossing the seam. */
const isJsonObject = Schema.is(JsonObject);

/** Carries approval conflict through the typed approvals failure channel without losing diagnostic context. */
export class ApprovalConflict extends Schema.TaggedError<ApprovalConflict>()(
	'Bolt.Approvals.Conflict',
	{
		requestId: Schema.NonEmptyString,
		reason: Schema.NonEmptyString
	}
) {
	readonly category = 'approval-conflict' as const;
	readonly retryable = false;
}

/** Owns decide state behavior at the approvals boundary so validation and typed semantics stay consistent for every caller. */
const ApprovalTransitions = {
	decide: (
		state: ApprovalState,
		decision: 'approve' | 'reject',
		actor: string,
		reason = '',
		steps = 1
	): ApprovalState | ApprovalConflict => {
		if (state._tag !== 'Pending')
			return new ApprovalConflict({
				requestId: state.requestId,
				reason: 'approval is no longer pending'
			});
		switch (decision) {
			case 'reject':
				return {
					_tag: 'Rejected',
					requestId: state.requestId,
					decidedBy: actor,
					reason,
					operation: state.operation
				};
			case 'approve': {
				const total = Math.max(1, steps);
				if (state.step + 1 < total) {
					return {
						_tag: 'Pending',
						requestId: state.requestId,
						step: state.step + 1,
						operation: state.operation
					};
				}
				return {
					_tag: 'Approved',
					requestId: state.requestId,
					decidedBy: actor,
					operation: state.operation
				};
			}
			default: {
				const _exhaustive: never = decision;
				return new ApprovalConflict({
					requestId: state.requestId,
					reason: `unsupported decision ${_exhaustive}`
				});
			}
		}
	}
};
export const decideState = ApprovalTransitions.decide;

export type Interface = Readonly<{
	readonly request: (
		effectId: EffectId,
		subject: Identity.Subject,
		requestId: string,
		operation: Schema.Json
	) => Effect.Effect<ApprovalState, Database.FacilityError | ApprovalConflict>;
	readonly decide: (
		effectId: EffectId,
		subject: Identity.Subject,
		state: ApprovalState,
		decision: 'approve' | 'reject',
		reason?: string
	) => Effect.Effect<
		ApprovalState,
		ApprovalConflict | AccessControl.AccessDenied | Database.FacilityError
	>;
	readonly withdraw: (
		effectId: EffectId,
		subject: Identity.Subject,
		state: ApprovalState
	) => Effect.Effect<ApprovalState, ApprovalConflict | Database.FacilityError>;
	readonly status: (
		effectId: EffectId,
		requestId: string
	) => Effect.Effect<ApprovalState | undefined, Database.FacilityError | ApprovalConflict>;
	readonly pendingForRecord: (
		effectId: EffectId,
		collection: string,
		id: string
	) => Effect.Effect<ApprovalState | undefined, Database.FacilityError | ApprovalConflict>;
	readonly timeline: (
		effectId: EffectId,
		requestId: string
	) => Effect.Effect<
		ReadonlyArray<ApprovalTimelineEvent>,
		Database.FacilityError | ApprovalConflict
	>;
	readonly authorizeResume: (state: ApprovalState) => Effect.Effect<void, ApprovalConflict>;
}>;

/** Identifies the approvals service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Approvals');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;
		const access = yield* AccessControl.Service;
		const queue = yield* TaskQueue.Service;
		const workspace = yield* Workspace.Service;
		const reportedStalePolicies = new Set<string>();
		/** Resolves the durable configuration embedded at request time, with authored grants as a legacy-state fallback. */
		const approvalConfigurations = {
			resolve: (state: ApprovalState) => {
				if (
					state._tag !== 'Pending' ||
					typeof state.operation !== 'object' ||
					state.operation === null ||
					Array.isArray(state.operation)
				)
					return undefined;
				const embedded = Reflect.get(state.operation, 'approval');
				if (Schema.is(ApprovalConfiguration)(embedded)) return embedded;
				const collection = Reflect.get(state.operation, 'collection');
				if (typeof collection !== 'string') return undefined;
				for (const policy of workspace.definition.policies) {
					for (const grant of policy.grants ?? []) {
						if (grant.collection === collection && Schema.is(ApprovalConfiguration)(grant.approval))
							return grant.approval;
					}
				}
				return undefined;
			}
		};
		const decodeState = Effect.fn('Approvals.decodeState')(function* (
			requestId: string,
			value: unknown
		) {
			return yield* Schema.decodeUnknownEffect(ApprovalState)(value).pipe(
				Effect.mapError(
					() => new ApprovalConflict({ requestId, reason: 'stored approval state is malformed' })
				)
			);
		});
		const status = Effect.fn('Approvals.status')(function* (effectId: EffectId, requestId: string) {
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'select state from bolt_approvals where request_id = $1',
				parameters: [requestId]
			});
			const row = result.rows[0];
			const state = typeof row === 'object' && row !== null ? Reflect.get(row, 'state') : undefined;
			if (state === undefined) return undefined;
			return yield* decodeState(requestId, state);
		});
		const pendingForRecord = Effect.fn('Approvals.pendingForRecord')(function* (
			effectId: EffectId,
			collection: string,
			id: string
		) {
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: "select state from bolt_approvals where state->>'_tag' = 'Pending' and state->'operation'->>'collection' = $1 and state->'operation'->>'id' = $2 limit 1",
				parameters: [collection, id]
			});
			const row = result.rows[0];
			const state = typeof row === 'object' && row !== null ? Reflect.get(row, 'state') : undefined;
			if (state === undefined) return undefined;
			return yield* decodeState(`${collection}:${id}`, state);
		});
		const timeline = Effect.fn('Approvals.timeline')(function* (
			effectId: EffectId,
			requestId: string
		) {
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'select kind, subject_id as "subjectId", payload from bolt_audit where payload->>\'requestId\' = $1 order by sequence',
				parameters: [requestId]
			});
			const events: Array<ApprovalTimelineEvent> = [];
			for (const row of result.rows) {
				events.push(
					yield* Schema.decodeUnknownEffect(ApprovalTimelineEvent)(row).pipe(
						Effect.mapError(
							() =>
								new ApprovalConflict({ requestId, reason: 'stored approval timeline is malformed' })
						)
					)
				);
			}
			return events;
		});
		const persistAudit = Effect.fn('Approvals.persistAudit')(function* (
			effectId: EffectId,
			kind: string,
			subjectId: string,
			payload: Schema.Json
		) {
			yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'insert into bolt_audit (kind, subject_id, payload) values ($1, $2, $3)',
				parameters: [kind, subjectId, payload]
			});
		});
		/**
		 * Mirrors durable approval state into the `approval_request` row authored code reads.
		 * `bolt_approvals` stays the authority; this projection is what makes status, close time,
		 * and the held records answerable by an ordinary collection query.
		 */
		const projectRequest = Effect.fn('Approvals.project')(function* (
			effectId: EffectId,
			state: ApprovalState,
			closedBy?: string
		) {
			const operation =
				state._tag === 'Pending' || state._tag === 'Approved' ? state.operation : undefined;
			const fields = isJsonObject(operation) ? operation : {};
			const collectionName =
				typeof fields['collection'] === 'string' ? fields['collection'] : 'unknown';
			const recordId = typeof fields['id'] === 'string' ? fields['id'] : 'unknown';
			const action = typeof fields['action'] === 'string' ? fields['action'] : 'update';
			const nowEpochMs = yield* Clock.currentTimeMillis;
			yield* database.execute(effectId, {
				_tag: 'Query',
				// `$6` and `$7` are cast, and their values are JSON text rather than arrays.
				//
				// A driver binds a JavaScript array to a Postgres *array*, not to JSON — so a `jsonb`
				// column handed `[{ step: 0 }]` receives array-literal syntax and answers `invalid input
				// syntax for type json`. This projection runs inside `request`, before the record is
				// locked, so the failure took the whole write-then-lock path down with it: every
				// approval-gated create wrote its row, threw here, and left the record unlocked with no
				// approval to find it by. Objects survive the same binding because a driver serialises
				// those to JSON; only arrays take the other path, which is why this was invisible
				// wherever a projection happened to carry none.
				sql: `insert into approval_request (id, collection_name, record_id, action, status, steps, locked_record_refs, closed_at, closed_by)
					values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
					on conflict (id) do update set status = excluded.status, closed_at = excluded.closed_at, closed_by = excluded.closed_by, updated_at = now()`,
				parameters: [
					state.requestId,
					collectionName,
					recordId,
					action,
					APPROVAL_STATUS[state._tag],
					JSON.stringify(state._tag === 'Pending' ? [{ step: state.step }] : []),
					JSON.stringify(
						collectionName === 'unknown'
							? []
							: [{ collection_name: collectionName, record_id: recordId }]
					),
					state._tag === 'Pending' ? null : new Date(nowEpochMs).toISOString(),
					closedBy ?? null
				]
			});
		});
		return Service.of({
			request: Effect.fn('Approvals.request')(function* (effectId, subject, requestId, operation) {
				let durableOperation = operation;
				// One decode of the operation at the seam: a collection-gated write arrives as a
				// `{ collection, ... }` object, and the data-browser command that posted it names the
				// collection it gated. Anything else is some other operation shape and is not gated.
				const gated = Schema.decodeUnknownOption(
					Schema.Struct({
						collection: Schema.String,
						approval: Schema.optionalKey(Schema.Json)
					}),
					{ onExcessProperty: 'ignore' }
				)(operation);
				const operationObject = Schema.decodeUnknownOption(JsonObject)(operation);
				if (
					gated._tag === 'Some' &&
					gated.value.approval === undefined &&
					operationObject._tag === 'Some'
				) {
					// The policies this subject's team declares, resolved the one way any policy is
					// selected — by name, against the team map the release carries.
					const held = AccessControl.policiesHeld(
						workspace.definition,
						subject,
						reportedStalePolicies
					);
					const configuration = workspace.definition.policies
						.filter((policy) => held.has(policy.name.toLocaleLowerCase()))
						.flatMap((policy) => policy.grants ?? [])
						.find(
							(grant) => grant.collection === gated.value.collection && grant.approval !== undefined
						)?.approval;
					if (isJsonObject(configuration))
						durableOperation = { ...operationObject.value, approval: configuration };
				}
				const state: ApprovalState = {
					_tag: 'Pending',
					requestId,
					step: 0,
					operation: durableOperation
				};
				const inserted = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'insert into bolt_approvals (request_id, tenant_id, state) values ($1, $2, $3) on conflict (request_id) do nothing returning state',
					parameters: [requestId, subject.tenantId, state]
				});
				if (inserted.affectedRows > 0) {
					yield* persistAudit(effectId, 'approval_requested', subject.userId, state);
					yield* projectRequest(effectId, state);
					yield* database.execute(effectId, {
						_tag: 'Query',
						sql: 'insert into requestor (id, approval_request_id, user_id) values ($1, $2, $3) on conflict (id) do nothing',
						parameters: [
							deriveRecordId(`${requestId}:${subject.userId}`),
							requestId,
							subject.userId
						]
					});
					return state;
				}
				const existing = yield* status(effectId, requestId);
				if (existing === undefined)
					return yield* new ApprovalConflict({
						requestId,
						reason: 'approval request conflicted without a durable state'
					});
				return existing;
			}),
			decide: Effect.fn('Approvals.decide')(function* (
				effectId,
				subject,
				state,
				decision,
				reason = ''
			) {
				const current = yield* status(effectId, state.requestId);
				if (current === undefined)
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'approval request was not found'
					});
				const configuration = approvalConfigurations.resolve(current);
				if (configuration === undefined) {
					yield* access.authorize(subject, 'approve', 'approvals');
				} else {
					const step = configuration.steps[current._tag === 'Pending' ? current.step : 0];
					const eligible =
						step !== undefined &&
						// One team, matched folded — the same rule the policy side uses, read from the one
						// place the subject's own team lives. It used to be an array compared
						// case-sensitively, which is how `approvers: ['HR Manger']` produced an approval
						// nobody could ever decide; folding closed the casing half of that and left the
						// typo half open, which is why `approvers` is now a generated union and a
						// misspelling fails the build instead.
						step.approvers.some(
							(team: string) =>
								team.toLocaleLowerCase() === subject.teamPath[0]?.toLocaleLowerCase()
						);
					if (!eligible)
						return yield* new AccessControl.AccessDenied({
							action: 'approve',
							resource: current.requestId,
							reason: 'subject is not an approver for the active step'
						});
				}
				const next = decideState(
					current,
					decision,
					subject.userId,
					reason,
					configuration === undefined ? 1 : configuration.steps.length
				);
				if (next instanceof ApprovalConflict) return yield* next;
				const updated = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: "with updated as (update bolt_approvals set state = $2 where request_id = $1 and state->>'_tag' = 'Pending' returning state) insert into bolt_audit (kind, subject_id, payload) select $3, $4, state from updated returning payload as state",
					parameters: [state.requestId, next, 'approval_decided', subject.userId]
				});
				if (updated.affectedRows === 0)
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'approval decision lost a competing update'
					});
				yield* projectRequest(effectId, next, subject.userId);
				if (next._tag === 'Approved') {
					yield* queue.enqueue(EffectId.make(`${effectId}:resume`), [
						{
							command: 'collections.resume',
							input: { requestId: next.requestId },
							effectId: `${effectId}:resume`
						}
					]);
				}
				// A rejection has work to do too. Only the approval path was ever followed up, so a
				// refused request left its record locked for good.
				if (next._tag === 'Rejected') {
					yield* queue.enqueue(EffectId.make(`${effectId}:discard`), [
						{
							command: 'collections.discard',
							input: { requestId: next.requestId },
							effectId: `${effectId}:discard`
						}
					]);
				}
				return next;
			}),
			withdraw: Effect.fn('Approvals.withdraw')(function* (effectId, subject, state) {
				const current = yield* status(effectId, state.requestId);
				if (current?._tag !== 'Pending')
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'approval is no longer pending'
					});
				const next: ApprovalState = {
					_tag: 'Withdrawn',
					requestId: state.requestId,
					withdrawnBy: subject.userId,
					operation: current.operation
				};
				const updated = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: "update bolt_approvals set state = $2 where request_id = $1 and state->>'_tag' = 'Pending' returning state",
					parameters: [state.requestId, next]
				});
				if (updated.affectedRows === 0)
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'approval withdrawal lost a competing update'
					});
				yield* projectRequest(effectId, next, subject.userId);
				yield* queue.enqueue(EffectId.make(`${effectId}:discard`), [
					{
						command: 'collections.discard',
						input: { requestId: next.requestId },
						effectId: `${effectId}:discard`
					}
				]);
				return next;
			}),
			status,
			pendingForRecord,
			timeline,
			authorizeResume: Effect.fn('Approvals.authorizeResume')(function* (state) {
				if (state._tag !== 'Approved')
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'approval has not been approved'
					});
			})
		});
	})
);
