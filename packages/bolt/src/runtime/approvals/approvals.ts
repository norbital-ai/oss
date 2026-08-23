import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import { enqueueFromCte } from '#lib/runtime/tasks/queue.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import * as SyncWake from '#lib/runtime/sync/wake.js';
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
	ChangesRequested: {
		requestId: Schema.NonEmptyString,
		decidedBy: Schema.NonEmptyString,
		reason: Schema.NonEmptyString,
		operation: Schema.optionalKey(Schema.Json)
	},
	Conflicted: {
		requestId: Schema.NonEmptyString,
		reason: Schema.NonEmptyString,
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
	ChangesRequested: 'CHANGES_REQUESTED',
	Conflicted: 'CONFLICTED',
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
		decision: 'approve' | 'reject' | 'request_changes',
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
			case 'request_changes':
				if (reason.trim() === '')
					return new ApprovalConflict({
						requestId: state.requestId,
						reason: 'requesting changes requires a reason'
					});
				return {
					_tag: 'ChangesRequested',
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

export type ApprovalRecordLock = Readonly<{
	readonly collection: string;
	readonly id: string;
}>;

export type Interface = Readonly<{
	readonly request: (
		effectId: EffectId,
		subject: Identity.Subject,
		requestId: string,
		operation: Schema.Json,
		lock?: ApprovalRecordLock
	) => Effect.Effect<ApprovalState, Database.FacilityError | ApprovalConflict>;
	readonly decide: (
		effectId: EffectId,
		subject: Identity.Subject,
		state: ApprovalState,
		decision: 'approve' | 'reject' | 'request_changes',
		reason?: string
	) => Effect.Effect<
		ApprovalState,
		ApprovalConflict | AccessControl.AccessDenied | Database.FacilityError
	>;
	readonly withdraw: (
		effectId: EffectId,
		subject: Identity.Subject,
		state: ApprovalState
	) => Effect.Effect<
		ApprovalState,
		ApprovalConflict | AccessControl.AccessDenied | Database.FacilityError
	>;
	/** Terminates an approved request whose reviewed graph can no longer be applied. */
	readonly conflict: (
		effectId: EffectId,
		requestId: string,
		reason: string
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
		const wake = yield* SyncWake.Service;
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
		const projectionOf = Effect.fn('Approvals.projectionOf')(function* (
			state: ApprovalState,
			closedBy?: string
		) {
			const operation = state.operation;
			const fields = isJsonObject(operation) ? operation : {};
			const collectionName =
				typeof fields['collection'] === 'string' ? fields['collection'] : 'unknown';
			const recordId = typeof fields['id'] === 'string' ? fields['id'] : 'unknown';
			const action = typeof fields['action'] === 'string' ? fields['action'] : 'update';
			const nowEpochMs = yield* Clock.currentTimeMillis;
			return {
				collectionName,
				recordId,
				action,
				status: APPROVAL_STATUS[state._tag],
				steps: JSON.stringify(state._tag === 'Pending' ? [{ step: state.step }] : []),
				lockedRecordRefs: JSON.stringify(
					collectionName === 'unknown'
						? []
						: [{ collection_name: collectionName, record_id: recordId }]
				),
				proposedValues: JSON.stringify(fields['values'] ?? {}),
				closedAt: state._tag === 'Pending' ? null : new Date(nowEpochMs).toISOString(),
				closedBy: closedBy ?? null
			};
		});
		const conflict = Effect.fn('Approvals.conflict')(function* (
			effectId: EffectId,
			requestId: string,
			reason: string
		) {
			const current = yield* status(effectId, requestId);
			if (current?._tag !== 'Approved')
				return yield* new ApprovalConflict({
					requestId,
					reason: 'only an approved request may be marked conflicted'
				});
			const next: ApprovalState = {
				_tag: 'Conflicted',
				requestId,
				reason,
				...(current.operation === undefined ? {} : { operation: current.operation })
			};
			const projection = yield* projectionOf(next, current.decidedBy);
			const operation = isJsonObject(current.operation) ? current.operation : {};
			const collection =
				typeof operation['collection'] === 'string' ? operation['collection'] : undefined;
			const recordId = typeof operation['id'] === 'string' ? operation['id'] : undefined;
			const quotedCollection =
				collection === undefined ? undefined : `"${collection.replaceAll('"', '""')}"`;
			const releaseCte =
				quotedCollection === undefined || recordId === undefined
					? ''
					: `, released as (
						update ${quotedCollection} as target set approval_id = null
						where target.approval_id = $1::uuid and target.id = $13::uuid
							and exists (select 1 from updated)
						returning target.id::text as id, to_jsonb(target) as record
					), lock_synced as (
						insert into bolt_sync_outbox (collection_name, record_id, operation, record)
						select $14, id, 'update', record from released
						returning sequence
					)`;
			const parameters: Array<Schema.Json> = [
				requestId,
				next,
				current.decidedBy,
				projection.collectionName,
				projection.recordId,
				projection.action,
				projection.status,
				projection.steps,
				projection.lockedRecordRefs,
				projection.closedAt,
				projection.closedBy,
				projection.proposedValues,
				...(recordId === undefined || collection === undefined ? [] : [recordId, collection])
			];
			const updated = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `with updated as (
					update bolt_approvals set state = $2
					where request_id = $1 and state->>'_tag' = 'Approved'
					returning state
				), audited as (
					insert into bolt_audit (kind, subject_id, payload)
					select 'approval_conflicted', $3, state from updated
					returning sequence
				), projected as (
					insert into approval_request (id, collection_name, record_id, action, status, steps, locked_record_refs, proposed_values, closed_at, closed_by)
					select $1::uuid, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $12::jsonb, $10, $11 from updated
					on conflict (id) do update set status = excluded.status, steps = excluded.steps, proposed_values = excluded.proposed_values, closed_at = excluded.closed_at, closed_by = excluded.closed_by, updated_at = now()
					returning id::text as id, to_jsonb(approval_request) as record
				), synced as (
					insert into bolt_sync_outbox (collection_name, record_id, operation, record)
					select 'approval_request', id, 'update', record from projected
					returning sequence
				)${releaseCte}
				select state from updated`,
				parameters
			});
			if (updated.rows.length === 0)
				return yield* new ApprovalConflict({
					requestId,
					reason: 'approval conflict lost a competing state transition'
				});
			const changed = ['approval_request', ...(collection === undefined ? [] : [collection])];
			yield* wake
				.announce(EffectId.make(`${effectId}:approval-conflict-wake`), changed)
				.pipe(Effect.timeout(250), Effect.ignore);
			return next;
		});
		return Service.of({
			request: Effect.fn('Approvals.request')(
				function* (effectId, subject, requestId, operation, lock) {
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
								(grant) =>
									grant.collection === gated.value.collection && grant.approval !== undefined
							)?.approval;
						if (isJsonObject(configuration))
							durableOperation = { ...operationObject.value, approval: configuration };
						else {
							const genericApprovers = Object.keys(workspace.definition.teams ?? {}).filter(
								(team) => {
									const candidate = { ...subject, teamPath: [team], admin: false };
									const candidatePolicies = AccessControl.policiesHeld(
										workspace.definition,
										candidate,
										reportedStalePolicies
									);
									return AccessControl.decide(
										workspace.definition.policies,
										candidate,
										'approve',
										'approvals',
										candidatePolicies
									).allowed;
								}
							);
							if (genericApprovers.length > 0)
								durableOperation = { ...operationObject.value, genericApprovers };
						}
					}
					const state: ApprovalState = {
						_tag: 'Pending',
						requestId,
						step: 0,
						operation: durableOperation
					};
					const projection = yield* projectionOf(state);
					const requestorId = deriveRecordId(`${requestId}:${subject.userId}`);
					const parameters: Array<Schema.Json> = [];
					const bind = (value: Schema.Json): string => `$${parameters.push(value)}`;
					const requestParameter = bind(requestId);
					const tenantParameter = bind(subject.tenantId);
					const stateParameter = bind(state);
					const subjectParameter = bind(subject.userId);
					const collectionParameter = bind(projection.collectionName);
					const recordParameter = bind(projection.recordId);
					const actionParameter = bind(projection.action);
					const statusParameter = bind(projection.status);
					const stepsParameter = bind(projection.steps);
					const refsParameter = bind(projection.lockedRecordRefs);
					const proposedParameter = bind(projection.proposedValues);
					const closedAtParameter = bind(projection.closedAt);
					const closedByParameter = bind(projection.closedBy);
					const requestorParameter = bind(requestorId);
					const quotedLockCollection =
						lock === undefined ? undefined : `"${lock.collection.replaceAll('"', '""')}"`;
					const lockIdParameter = lock === undefined ? undefined : bind(lock.id);
					const lockCollectionParameter = lock === undefined ? undefined : bind(lock.collection);
					const lockCtes =
						lock === undefined
							? ''
							: `locked as (
							update ${quotedLockCollection} as target set approval_id = ${requestParameter}::uuid
							where target.id = ${lockIdParameter}::uuid and target.approval_id is null
								and not exists (select 1 from bolt_approvals where request_id = ${requestParameter})
							returning target.id::text as id, to_jsonb(target) as record
						),`;
					const insertedSource =
						lock === undefined
							? `values (${requestParameter}, ${tenantParameter}, ${stateParameter})`
							: `select ${requestParameter}, ${tenantParameter}, ${stateParameter} from locked`;
					const lockSyncCte =
						lock === undefined
							? ''
							: `, lock_synced as (
							insert into bolt_sync_outbox (collection_name, record_id, operation, record)
							select ${lockCollectionParameter}, locked.id, 'update', locked.record
							from locked join inserted on true
							returning sequence
						)`;
					const inserted = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: `with ${lockCtes} inserted as (
						insert into bolt_approvals (request_id, tenant_id, state)
						${insertedSource}
						on conflict (request_id) do nothing
						returning state
					), audited as (
						insert into bolt_audit (kind, subject_id, payload)
						select 'approval_requested', ${subjectParameter}, state from inserted
						returning sequence
					), projected as (
						insert into approval_request (id, collection_name, record_id, action, status, steps, locked_record_refs, proposed_values, closed_at, closed_by)
						select ${requestParameter}::uuid, ${collectionParameter}, ${recordParameter}, ${actionParameter}, ${statusParameter}, ${stepsParameter}::jsonb, ${refsParameter}::jsonb, ${proposedParameter}::jsonb, ${closedAtParameter}, ${closedByParameter} from inserted
						on conflict (id) do update set status = excluded.status, steps = excluded.steps, proposed_values = excluded.proposed_values, closed_at = excluded.closed_at, closed_by = excluded.closed_by, updated_at = now()
						returning id::text as id, to_jsonb(approval_request) as record
					), request_synced as (
						insert into bolt_sync_outbox (collection_name, record_id, operation, record)
						select 'approval_request', id, 'create', record from projected
						returning sequence
					), requestor_projected as (
						insert into requestor (id, approval_request_id, user_id)
						select ${requestorParameter}::uuid, ${requestParameter}, ${subjectParameter}
						from inserted join request_synced on true
						on conflict (id) do nothing
						returning id::text as id, to_jsonb(requestor) as record
					), requestor_synced as (
						insert into bolt_sync_outbox (collection_name, record_id, operation, record)
						select 'requestor', id, 'create', record from requestor_projected
						returning sequence
					)${lockSyncCte}
					select state from inserted`,
						parameters
					});
					if (inserted.rows.length > 0) {
						const collections = [
							'approval_request',
							'requestor',
							...(lock === undefined ? [] : [lock.collection])
						];
						yield* wake
							.announce(EffectId.make(`${effectId}:approval-request-wake`), collections)
							.pipe(Effect.timeout(250), Effect.ignore);
						return state;
					}
					if (lock !== undefined)
						return yield* new ApprovalConflict({
							requestId,
							reason: `${lock.collection} ${lock.id} could not be locked for approval`
						});
					const existing = yield* status(effectId, requestId);
					if (existing === undefined)
						return yield* new ApprovalConflict({
							requestId,
							reason: 'approval request conflicted without a durable state'
						});
					return existing;
				}
			),
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
				const projection = yield* projectionOf(next, subject.userId);
				const followup =
					next._tag === 'Approved'
						? {
								command: 'collections.resume',
								effectId: `${effectId}:resume`,
								input: { requestId: next.requestId }
							}
						: next._tag === 'Rejected' || next._tag === 'ChangesRequested'
							? {
									command: 'collections.discard',
									effectId: `${effectId}:discard`,
									input: { requestId: next.requestId }
								}
							: undefined;
				if (followup !== undefined)
					yield* queue.wake(
						EffectId.make(`${effectId}:approval-followup-wake`),
						yield* Clock.currentTimeMillis
					);
				const taskCte =
					followup === undefined ? undefined : enqueueFromCte('queued', 'updated', followup, 13);
				const updated = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `with updated as (
						update bolt_approvals set state = $2
						where request_id = $1 and state->>'_tag' = 'Pending'
						returning state
					), audited as (
						insert into bolt_audit (kind, subject_id, payload)
						select 'approval_decided', $3, state from updated
						returning sequence
					), projected as (
						insert into approval_request (id, collection_name, record_id, action, status, steps, locked_record_refs, proposed_values, closed_at, closed_by)
						select $1::uuid, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $12::jsonb, $10, $11 from updated
						on conflict (id) do update set status = excluded.status, steps = excluded.steps, proposed_values = excluded.proposed_values, closed_at = excluded.closed_at, closed_by = excluded.closed_by, updated_at = now()
						returning id::text as id, to_jsonb(approval_request) as record
					), synced as (
						insert into bolt_sync_outbox (collection_name, record_id, operation, record)
						select 'approval_request', id, 'update', record from projected
						returning sequence
					)${taskCte?.sql ?? ''}
					select state from updated`,
					parameters: [
						state.requestId,
						next,
						subject.userId,
						projection.collectionName,
						projection.recordId,
						projection.action,
						projection.status,
						projection.steps,
						projection.lockedRecordRefs,
						projection.closedAt,
						projection.closedBy,
						projection.proposedValues,
						...(taskCte?.parameters ?? [])
					]
				});
				if (updated.rows.length === 0)
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'approval decision lost a competing update'
					});
				yield* wake
					.announce(EffectId.make(`${effectId}:approval-decision-wake`), ['approval_request'])
					.pipe(Effect.timeout(250), Effect.ignore);
				return next;
			}),
			withdraw: Effect.fn('Approvals.withdraw')(function* (effectId, subject, state) {
				const current = yield* status(effectId, state.requestId);
				if (current?._tag !== 'Pending')
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'approval is no longer pending'
					});
				const requestor = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'select 1 from requestor where approval_request_id = $1 and user_id = $2 limit 1',
					parameters: [state.requestId, subject.userId]
				});
				if (requestor.rows.length === 0)
					return yield* new AccessControl.AccessDenied({
						action: 'withdraw',
						resource: state.requestId,
						reason: 'only the requestor may withdraw an approval'
					});
				const next: ApprovalState = {
					_tag: 'Withdrawn',
					requestId: state.requestId,
					withdrawnBy: subject.userId,
					operation: current.operation
				};
				const projection = yield* projectionOf(next, subject.userId);
				const discardEffectId = `${effectId}:discard`;
				yield* queue.wake(
					EffectId.make(`${effectId}:approval-withdraw-followup-wake`),
					yield* Clock.currentTimeMillis
				);
				const discardTask = enqueueFromCte(
					'queued',
					'updated',
					{
						command: 'collections.discard',
						input: { requestId: next.requestId },
						effectId: discardEffectId
					},
					13
				);
				const updated = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `with updated as (
						update bolt_approvals set state = $2
						where request_id = $1 and state->>'_tag' = 'Pending'
						returning state
					), audited as (
						insert into bolt_audit (kind, subject_id, payload)
						select 'approval_withdrawn', $3, state from updated
						returning sequence
					), projected as (
						insert into approval_request (id, collection_name, record_id, action, status, steps, locked_record_refs, proposed_values, closed_at, closed_by)
						select $1::uuid, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $12::jsonb, $10, $11 from updated
						on conflict (id) do update set status = excluded.status, steps = excluded.steps, proposed_values = excluded.proposed_values, closed_at = excluded.closed_at, closed_by = excluded.closed_by, updated_at = now()
						returning id::text as id, to_jsonb(approval_request) as record
					), synced as (
						insert into bolt_sync_outbox (collection_name, record_id, operation, record)
						select 'approval_request', id, 'update', record from projected
						returning sequence
					)${discardTask.sql}
					select state from updated`,
					parameters: [
						state.requestId,
						next,
						subject.userId,
						projection.collectionName,
						projection.recordId,
						projection.action,
						projection.status,
						projection.steps,
						projection.lockedRecordRefs,
						projection.closedAt,
						projection.closedBy,
						projection.proposedValues,
						...discardTask.parameters
					]
				});
				if (updated.rows.length === 0)
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'approval withdrawal lost a competing update'
					});
				yield* wake
					.announce(EffectId.make(`${effectId}:approval-withdraw-wake`), ['approval_request'])
					.pipe(Effect.timeout(250), Effect.ignore);
				return next;
			}),
			conflict,
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
