import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { and, asc, eq, exists, isNull, notExists } from 'drizzle-orm';
import { compileModelTable } from '#lib/authoring/model-introspection.js';
import { defineModel } from '#lib/authoring/models-schema.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Database from '#lib/runtime/facilities/database.js';
import {
	aliased,
	always,
	bound,
	composer,
	dbNow,
	excluded,
	executeBuilt,
	jsonb,
	jsonTextEquals
} from '#lib/runtime/persistence.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import * as SyncWake from '#lib/runtime/sync/wake.js';

const {
	approval_request: approvalRequestTable,
	requestor: requestorTable,
	bolt_approvals: approvalStateTable,
	bolt_audit: auditTable,
	bolt_notifications: notificationTable,
	bolt_task: taskTable
} = SYSTEM_MODEL_TABLES;

type ApprovalProjection = Readonly<{
	readonly collectionName: string;
	readonly recordId: string;
	readonly action: string;
	readonly status: string;
	readonly steps: Schema.Json;
	readonly approverTeams: Schema.Json;
	readonly supersederTeams: Schema.Json;
	readonly lockedRecordRefs: Schema.Json;
	readonly proposedValues: Schema.Json;
	readonly closedAt: string | null;
	readonly closedBy: string | null;
}>;

type ApprovalFollowup = Readonly<{
	readonly command: string;
	readonly effectId: string;
	readonly input: Schema.Json;
}>;

type ApprovalNotification = Readonly<{
	readonly id: string;
	readonly payload: Schema.Json;
}>;

export const ApprovalState = Schema.TaggedUnion({
	Pending: {
		requestId: Schema.NonEmptyString,
		step: Schema.Number.check(Schema.isInt()),
		operation: Schema.Json
	},
	Approved: {
		requestId: Schema.NonEmptyString,
		decidedBy: Schema.NonEmptyString,
		superseded: Schema.optionalKey(Schema.Literal(true)),
		reason: Schema.optionalKey(Schema.NonEmptyString),
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
/**
 * An epoch instant as the ISO-8601 text a row stores.
 *
 * A pure conversion of a reading the workflow already took from `Clock`, so it lives out here rather
 * than inside the workflow, where a bare `new Date` reads as a second source of time.
 */
const instantLabel = (epochMs: number): string => new Date(epochMs).toISOString();

const APPROVAL_STATUS: Readonly<Record<ApprovalState['_tag'], string>> = {
	Pending: 'ONGOING',
	Approved: 'APPROVED',
	Rejected: 'REJECTED',
	ChangesRequested: 'CHANGES_REQUESTED',
	Conflicted: 'CONFLICTED',
	Withdrawn: 'WITHDRAWN'
};

// repository-health:allow EXP1 -- Exported dependent Layer declarations require this cross-module schema name during declaration emit.
export const ApprovalTimelineEvent = Schema.Struct({
	kind: Schema.NonEmptyString,
	subjectId: Schema.NonEmptyString,
	payload: Schema.Json
});
// repository-health:allow EXP1 -- Exported dependent Layer declarations require this cross-module row type during declaration emit.
export interface ApprovalTimelineEvent extends Schema.Schema.Type<typeof ApprovalTimelineEvent> {}

const ApprovalConfiguration = Schema.Struct({
	id: Schema.NonEmptyString,
	steps: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			approvers: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty())
		})
	).check(Schema.isNonEmpty()),
	superceded_by: Schema.Array(Schema.NonEmptyString)
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
		decision: 'approve' | 'reject' | 'request_changes' | 'supersede',
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
			case 'supersede':
				if (reason.trim() === '')
					return new ApprovalConflict({
						requestId: state.requestId,
						reason: 'superseding an approval requires a reason'
					});
				return {
					_tag: 'Approved',
					requestId: state.requestId,
					decidedBy: actor,
					superseded: true,
					reason: reason.trim(),
					operation: state.operation
				};
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

type ApprovalRecordLock = Readonly<{
	readonly collection: string;
	readonly id: string;
}>;

type ApprovalCapabilities = Readonly<{
	readonly canDecide: boolean;
	readonly canSupersede: boolean;
	readonly canWithdraw: boolean;
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
		decision: 'approve' | 'reject' | 'request_changes' | 'supersede',
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
	/** Actions the current principal may take on the current durable state. */
	readonly capabilities: (
		effectId: EffectId,
		subject: Identity.Subject,
		requestId: string
	) => Effect.Effect<ApprovalCapabilities, Database.FacilityError | ApprovalConflict>;
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
		/** Resolves only the concrete configuration embedded when the flow was selected. */
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
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ state: approvalStateTable.state })
					.from(approvalStateTable)
					.where(eq(approvalStateTable.request_id, requestId))
					.limit(1)
			);
			const row = result.rows[0];
			const state = typeof row === 'object' && row !== null ? Reflect.get(row, 'state') : undefined;
			if (state === undefined) return undefined;
			return yield* decodeState(requestId, state);
		});
		/**
		 * The decision entitlement for this exact durable step.
		 *
		 * Kept beside the mutation that consumes it: the browser projection and `decide` both read this
		 * answer, so adding a new approval shape cannot make a button appear that the command will deny.
		 */
		const decisionCapability = (subject: Identity.Subject, state: ApprovalState) => {
			if (state._tag !== 'Pending') {
				return { allowed: false, reason: 'approval is no longer pending' };
			}
			const configuration = approvalConfigurations.resolve(state);
			if (configuration === undefined) return access.explain(subject, 'approve', 'approvals');
			const step = configuration.steps[state.step];
			const allowed =
				step !== undefined &&
				step.approvers.some(
					(team: string) => team.toLocaleLowerCase() === subject.teamPath[0]?.toLocaleLowerCase()
				);
			return {
				allowed,
				reason: allowed
					? 'subject is an approver for the active step'
					: 'subject is not an approver for the active step'
			};
		};
		const supersedeCapability = (subject: Identity.Subject, state: ApprovalState) => {
			if (state._tag !== 'Pending') {
				return { allowed: false, reason: 'approval is no longer pending' };
			}
			const configuration = approvalConfigurations.resolve(state);
			if (configuration === undefined)
				return { allowed: false, reason: 'approval configuration is missing or malformed' };
			if (subject.admin === true) {
				return { allowed: true, reason: 'workspace administrator may supersede the approval' };
			}
			const team = subject.teamPath[0]?.toLocaleLowerCase();
			const allowed =
				team !== undefined &&
				configuration.superceded_by.some(
					(candidate: string) => candidate.toLocaleLowerCase() === team
				);
			return {
				allowed,
				reason: allowed
					? 'subject team may supersede the approval'
					: 'subject may not supersede the approval'
			};
		};
		const isRequestor = Effect.fn('Approvals.isRequestor')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			requestId: string
		) {
			const requestor = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ id: requestorTable.id })
					.from(requestorTable)
					.where(
						and(
							eq(requestorTable.approval_request_id, requestId),
							eq(requestorTable.user_id, subject.userId)
						)
					)
					.limit(1)
			);
			return requestor.rows.length > 0;
		});
		const capabilities = Effect.fn('Approvals.capabilities')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			requestId: string
		) {
			const current = yield* status(effectId, requestId);
			if (current?._tag !== 'Pending')
				return { canDecide: false, canSupersede: false, canWithdraw: false };
			return {
				canDecide: decisionCapability(subject, current).allowed,
				canSupersede: supersedeCapability(subject, current).allowed,
				canWithdraw: yield* isRequestor(effectId, subject, requestId)
			};
		});
		const pendingForRecord = Effect.fn('Approvals.pendingForRecord')(function* (
			effectId: EffectId,
			collection: string,
			id: string
		) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ id: approvalRequestTable.id })
					.from(approvalRequestTable)
					.where(
						and(
							eq(approvalRequestTable.collection_name, collection),
							eq(approvalRequestTable.record_id, id),
							eq(approvalRequestTable.status, 'ONGOING')
						)
					)
					.limit(1)
			);
			const row = result.rows[0];
			const requestId =
				typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : undefined;
			if (typeof requestId !== 'string') return undefined;
			return yield* status(effectId, requestId);
		});
		const timeline = Effect.fn('Approvals.timeline')(function* (
			effectId: EffectId,
			requestId: string
		) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({
						kind: auditTable.kind,
						subjectId: auditTable.subject_id,
						payload: auditTable.payload
					})
					.from(auditTable)
					.where(eq(auditTable.request_id, requestId))
					.orderBy(asc(auditTable.sequence))
			);
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
			const configuration = approvalConfigurations.resolve(state);
			const activeStep = state._tag === 'Pending' ? configuration?.steps[state.step] : undefined;
			const nowEpochMs = yield* Clock.currentTimeMillis;
			return {
				collectionName,
				recordId,
				action,
				status: APPROVAL_STATUS[state._tag],
				steps: state._tag === 'Pending' ? [{ step: state.step }] : [],
				approverTeams: (activeStep?.approvers ?? []).map((team: string) =>
					team.toLocaleLowerCase()
				),
				supersederTeams:
					state._tag === 'Pending'
						? (configuration?.superceded_by ?? []).map((team: string) => team.toLocaleLowerCase())
						: [],
				lockedRecordRefs:
					collectionName === 'unknown'
						? []
						: [{ collection_name: collectionName, record_id: recordId }],
				proposedValues: fields['values'] ?? {},
				closedAt: state._tag === 'Pending' ? null : instantLabel(nowEpochMs),
				closedBy: closedBy ?? null
			};
		});
		/**
		 * One guarded approval transition and all of its projections, composed as a single statement.
		 * Every dependent CTE reads from `updated`, so losing the optimistic state check writes nothing.
		 */
		const transitionQuery = (
			requestId: string,
			next: ApprovalState,
			actor: string,
			auditKind: string,
			projection: ApprovalProjection,
			followup?: ApprovalFollowup,
			notification?: ApprovalNotification
		) => {
			const updated = composer.$with('updated').as(
				composer
					.update(approvalStateTable)
					.set({ state: next })
					.where(
						and(
							eq(approvalStateTable.request_id, requestId),
							jsonTextEquals(approvalStateTable.state, '_tag', 'Pending')
						)
					)
					.returning({ state: approvalStateTable.state })
			);
			const audited = composer.$with('audited').as(
				composer
					.insert(auditTable)
					.select(
						composer
							.select({
								kind: aliased(bound(auditKind), 'kind'),
								subject_id: aliased(bound(actor), 'subject_id'),
								request_id: aliased(bound(requestId), 'request_id'),
								payload: updated.state
							})
							.from(updated)
					)
					.returning({ sequence: auditTable.sequence })
			);
			const projected = composer.$with('projected').as(
				composer
					.insert(approvalRequestTable)
					.select(
						composer
							.select({
								id: aliased(bound(requestId), 'id'),
								collection_name: aliased(bound(projection.collectionName), 'collection_name'),
								record_id: aliased(bound(projection.recordId), 'record_id'),
								action: aliased(bound(projection.action), 'action'),
								status: aliased(bound(projection.status), 'status'),
								steps: aliased(jsonb(projection.steps), 'steps'),
								approver_teams: aliased(jsonb(projection.approverTeams), 'approver_teams'),
								superseder_teams: aliased(jsonb(projection.supersederTeams), 'superseder_teams'),
								locked_record_refs: aliased(
									jsonb(projection.lockedRecordRefs),
									'locked_record_refs'
								),
								proposed_values: aliased(jsonb(projection.proposedValues), 'proposed_values'),
								closed_at: aliased(bound(projection.closedAt), 'closed_at'),
								closed_by: aliased(bound(projection.closedBy), 'closed_by')
							})
							.from(updated)
					)
					.onConflictDoUpdate({
						target: approvalRequestTable.id,
						set: {
							status: excluded(approvalRequestTable.status),
							steps: excluded(approvalRequestTable.steps),
							approver_teams: excluded(approvalRequestTable.approver_teams),
							superseder_teams: excluded(approvalRequestTable.superseder_teams),
							proposed_values: excluded(approvalRequestTable.proposed_values),
							closed_at: excluded(approvalRequestTable.closed_at),
							closed_by: excluded(approvalRequestTable.closed_by),
							updated_at: dbNow()
						}
					})
					.returning({ id: approvalRequestTable.id })
			);
			const queued =
				followup === undefined
					? undefined
					: composer.$with('queued').as(
							composer
								.insert(taskTable)
								.select(
									composer
										.select({
											command: aliased(bound(followup.command), 'command'),
											input: aliased(jsonb(followup.input), 'input'),
											effect_id: aliased(bound(followup.effectId), 'effect_id')
										})
										.from(updated)
								)
								.onConflictDoNothing({ target: taskTable.effect_id })
								.returning({ id: taskTable.id })
						);
			const notified =
				notification === undefined
					? undefined
					: composer.$with('notified').as(
							composer
								.insert(notificationTable)
								.select(
									composer
										.select({
											id: aliased(bound(notification.id), 'id'),
											recipient: requestorTable.user_id,
											payload: aliased(jsonb(notification.payload), 'payload'),
											read: aliased(bound(false), 'read')
										})
										.from(requestorTable)
										.innerJoin(updated, eq(requestorTable.approval_request_id, requestId))
								)
								.onConflictDoNothing({ target: notificationTable.id })
								.returning({ id: notificationTable.id })
						);
			if (queued === undefined) {
				return composer
					.with(updated, audited, projected)
					.select({ state: updated.state })
					.from(updated);
			}
			if (notified === undefined) {
				return composer
					.with(updated, audited, projected, queued)
					.select({ state: updated.state })
					.from(updated);
			}
			return composer
				.with(updated, audited, projected, queued, notified)
				.select({ state: updated.state })
				.from(updated);
		};
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
			const updatedState = composer.$with('updated').as(
				composer
					.update(approvalStateTable)
					.set({ state: next })
					.where(
						and(
							eq(approvalStateTable.request_id, requestId),
							jsonTextEquals(approvalStateTable.state, '_tag', 'Approved')
						)
					)
					.returning({ state: approvalStateTable.state })
			);
			const audited = composer.$with('audited').as(
				composer
					.insert(auditTable)
					.select(
						composer
							.select({
								kind: aliased(bound('approval_conflicted'), 'kind'),
								subject_id: aliased(bound(current.decidedBy), 'subject_id'),
								request_id: aliased(bound(requestId), 'request_id'),
								payload: updatedState.state
							})
							.from(updatedState)
					)
					.returning({ sequence: auditTable.sequence })
			);
			const projected = composer.$with('projected').as(
				composer
					.insert(approvalRequestTable)
					.select(
						composer
							.select({
								id: aliased(bound(requestId), 'id'),
								collection_name: aliased(bound(projection.collectionName), 'collection_name'),
								record_id: aliased(bound(projection.recordId), 'record_id'),
								action: aliased(bound(projection.action), 'action'),
								status: aliased(bound(projection.status), 'status'),
								steps: aliased(jsonb(projection.steps), 'steps'),
								approver_teams: aliased(jsonb(projection.approverTeams), 'approver_teams'),
								superseder_teams: aliased(jsonb(projection.supersederTeams), 'superseder_teams'),
								locked_record_refs: aliased(
									jsonb(projection.lockedRecordRefs),
									'locked_record_refs'
								),
								proposed_values: aliased(jsonb(projection.proposedValues), 'proposed_values'),
								closed_at: aliased(bound(projection.closedAt), 'closed_at'),
								closed_by: aliased(bound(projection.closedBy), 'closed_by')
							})
							.from(updatedState)
					)
					.onConflictDoUpdate({
						target: approvalRequestTable.id,
						set: {
							status: excluded(approvalRequestTable.status),
							steps: excluded(approvalRequestTable.steps),
							approver_teams: excluded(approvalRequestTable.approver_teams),
							superseder_teams: excluded(approvalRequestTable.superseder_teams),
							proposed_values: excluded(approvalRequestTable.proposed_values),
							closed_at: excluded(approvalRequestTable.closed_at),
							closed_by: excluded(approvalRequestTable.closed_by),
							updated_at: dbNow()
						}
					})
					.returning({ id: approvalRequestTable.id })
			);
			const released =
				collection === undefined || recordId === undefined
					? undefined
					: (() => {
							const target = compileModelTable(collection, defineModel({}));
							return composer.$with('released').as(
								composer
									.update(target)
									.set({ approval_id: null })
									.where(
										and(
											eq(target.approval_id, requestId),
											eq(target.id, recordId),
											exists(composer.select({ state: updatedState.state }).from(updatedState))
										)
									)
									.returning({ id: target.id })
							);
						})();
			const transition =
				released === undefined
					? composer
							.with(updatedState, audited, projected)
							.select({ state: updatedState.state })
							.from(updatedState)
					: composer
							.with(updatedState, audited, projected, released)
							.select({ state: updatedState.state })
							.from(updatedState);
			const updated = yield* executeBuilt(effectId, database, transition);
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
					const operationObject = Schema.decodeUnknownOption(JsonObject)(operation);
					if (
						operationObject._tag === 'None' ||
						!Schema.is(ApprovalConfiguration)(operationObject.value['approval'])
					)
						return yield* new ApprovalConflict({
							requestId,
							reason: 'approval requests require one concrete embedded approval flow'
						});
					const durableOperation = operationObject.value;
					const state: ApprovalState = {
						_tag: 'Pending',
						requestId,
						step: 0,
						operation: durableOperation
					};
					const projection = yield* projectionOf(state);
					const requestorId = deriveRecordId(`${requestId}:${subject.userId}`);
					const locked =
						lock === undefined
							? undefined
							: (() => {
									const target = compileModelTable(lock.collection, defineModel({}));
									return composer.$with('locked').as(
										composer
											.update(target)
											.set({ approval_id: requestId })
											.where(
												and(
													eq(target.id, lock.id),
													isNull(target.approval_id),
													notExists(
														composer
															.select({ id: approvalStateTable.id })
															.from(approvalStateTable)
															.where(eq(approvalStateTable.request_id, requestId))
													)
												)
											)
											.returning({ id: target.id })
									);
								})();
					const insertedState = composer.$with('inserted').as(
						(lock === undefined || locked === undefined
							? composer.insert(approvalStateTable).values({
									request_id: requestId,
									tenant_id: subject.tenantId,
									state
								})
							: composer.insert(approvalStateTable).select(
									composer
										.select({
											request_id: aliased(bound(requestId), 'request_id'),
											tenant_id: aliased(bound(subject.tenantId), 'tenant_id'),
											state: aliased(jsonb(state), 'state')
										})
										.from(locked)
								)
						)
							.onConflictDoNothing({ target: approvalStateTable.request_id })
							.returning({ state: approvalStateTable.state })
					);
					const audited = composer.$with('audited').as(
						composer
							.insert(auditTable)
							.select(
								composer
									.select({
										kind: aliased(bound('approval_requested'), 'kind'),
										subject_id: aliased(bound(subject.userId), 'subject_id'),
										request_id: aliased(bound(requestId), 'request_id'),
										payload: insertedState.state
									})
									.from(insertedState)
							)
							.returning({ sequence: auditTable.sequence })
					);
					const projected = composer.$with('projected').as(
						composer
							.insert(approvalRequestTable)
							.select(
								composer
									.select({
										id: aliased(bound(requestId), 'id'),
										collection_name: aliased(bound(projection.collectionName), 'collection_name'),
										record_id: aliased(bound(projection.recordId), 'record_id'),
										action: aliased(bound(projection.action), 'action'),
										status: aliased(bound(projection.status), 'status'),
										steps: aliased(jsonb(projection.steps), 'steps'),
										approver_teams: aliased(jsonb(projection.approverTeams), 'approver_teams'),
										superseder_teams: aliased(
											jsonb(projection.supersederTeams),
											'superseder_teams'
										),
										locked_record_refs: aliased(
											jsonb(projection.lockedRecordRefs),
											'locked_record_refs'
										),
										proposed_values: aliased(jsonb(projection.proposedValues), 'proposed_values'),
										closed_at: aliased(bound(projection.closedAt), 'closed_at'),
										closed_by: aliased(bound(projection.closedBy), 'closed_by')
									})
									.from(insertedState)
							)
							.onConflictDoUpdate({
								target: approvalRequestTable.id,
								set: {
									status: excluded(approvalRequestTable.status),
									steps: excluded(approvalRequestTable.steps),
									approver_teams: excluded(approvalRequestTable.approver_teams),
									superseder_teams: excluded(approvalRequestTable.superseder_teams),
									proposed_values: excluded(approvalRequestTable.proposed_values),
									closed_at: excluded(approvalRequestTable.closed_at),
									closed_by: excluded(approvalRequestTable.closed_by),
									updated_at: dbNow()
								}
							})
							.returning({ id: approvalRequestTable.id })
					);
					const requestorProjected = composer.$with('requestor_projected').as(
						composer
							.insert(requestorTable)
							.select(
								composer
									.select({
										id: aliased(bound(requestorId), 'id'),
										approval_request_id: aliased(bound(requestId), 'approval_request_id'),
										user_id: aliased(bound(subject.userId), 'user_id')
									})
									.from(insertedState)
									.innerJoin(projected, always())
							)
							.onConflictDoNothing({ target: requestorTable.id })
							.returning({ id: requestorTable.id })
					);
					const requestQuery =
						locked === undefined
							? composer
									.with(insertedState, audited, projected, requestorProjected)
									.select({ state: insertedState.state })
									.from(insertedState)
							: composer
									.with(locked, insertedState, audited, projected, requestorProjected)
									.select({ state: insertedState.state })
									.from(insertedState);
					const inserted = yield* executeBuilt(effectId, database, requestQuery);
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
				const capability =
					decision === 'supersede'
						? supersedeCapability(subject, current)
						: decisionCapability(subject, current);
				if (!capability.allowed)
					return yield* new AccessControl.AccessDenied({
						action: 'approve',
						resource: current.requestId,
						reason: capability.reason
					});
				const configuration = approvalConfigurations.resolve(current);
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
				const notification =
					next._tag === 'Approved' || next._tag === 'Rejected' || next._tag === 'ChangesRequested'
						? {
								id: deriveRecordId(`${next.requestId}:decision:${next._tag}`),
								payload: {
									text:
										next._tag === 'Approved'
											? next.superseded === true
												? `Approval superseded for ${projection.collectionName} ${projection.recordId}: ${next.reason}`
												: `Approval approved for ${projection.collectionName} ${projection.recordId}.`
											: next._tag === 'Rejected'
												? `Approval rejected for ${projection.collectionName} ${projection.recordId}.`
												: `Changes requested for ${projection.collectionName} ${projection.recordId}: ${next.reason}`,
									approvalRequestId: next.requestId,
									collection: projection.collectionName,
									recordId: projection.recordId,
									status: projection.status
								} satisfies Schema.Json
							}
						: undefined;
				const updated = yield* executeBuilt(
					effectId,
					database,
					transitionQuery(
						state.requestId,
						next,
						subject.userId,
						next._tag === 'Approved' && next.superseded === true
							? 'approval_superseded'
							: 'approval_decided',
						projection,
						followup,
						notification
					)
				);
				if (updated.rows.length === 0)
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'approval decision lost a competing update'
					});
				const changed = [
					'approval_request',
					...(notification === undefined ? [] : ['bolt_notifications'])
				];
				yield* wake
					.announce(EffectId.make(`${effectId}:approval-decision-wake`), changed)
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
				if (!(yield* isRequestor(effectId, subject, state.requestId)))
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
				const updated = yield* executeBuilt(
					effectId,
					database,
					transitionQuery(state.requestId, next, subject.userId, 'approval_withdrawn', projection, {
						command: 'collections.discard',
						input: { requestId: next.requestId },
						effectId: discardEffectId
					})
				);
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
			capabilities,
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
