import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import { Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { ApprovalState, EffectId, type SyncChange } from '@norbital-ai/bolt-protocol';
import { and, asc, eq, sql } from 'drizzle-orm';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { canonicalJson } from '#lib/canonical-json.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { SyncCommit } from '#lib/runtime/facilities/services.js';
import {
	aliased,
	always,
	bound,
	composer,
	dbNow,
	excluded,
	executeBuilt,
	jsonb,
	increment,
	rowJson,
	jsonTextEquals,
	toStatement,
	type Statement
} from '#lib/runtime/persistence.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as Identity from '#lib/runtime/identity/identity.js';

const {
	approval_request: approvalRequestTable,
	requestor: requestorTable,
	bolt_approvals: approvalStateTable,
	bolt_audit: auditTable,
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
	readonly closedAt: string | null;
	readonly closedBy: string | null;
}>;

type ApprovalFollowup = Readonly<{
	readonly command: string;
	readonly effectId: string;
	readonly input: Schema.Json;
}>;

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

const ResolvedApprovalConfiguration = Schema.Struct({
	id: Schema.NonEmptyString,
	steps: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			approvers: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty())
		})
	).check(Schema.isNonEmpty()),
	superceded_by: Schema.Array(Schema.NonEmptyString)
});
const isResolvedApprovalConfiguration = Schema.is(ResolvedApprovalConfiguration);

/** Stable structural identity for approval configurations authored with different key order. */
const approvalFingerprint = (value: Schema.Json | undefined): string =>
	value === undefined ? 'default' : canonicalJson(value);

/**
 * Structural identity of the concrete route a reviewer will actually follow.
 *
 * Configuration and stage ids identify the policy coordinate that produced a route; they are not
 * part of the route itself. The preparation review retains those coordinates independently, so a
 * changed policy still conflicts a pending approval without rejecting one graph that shares a route.
 */
export const approvalRouteFingerprint = (value: Schema.Json | undefined): string => {
	if (!isResolvedApprovalConfiguration(value)) return approvalFingerprint(value);
	return approvalFingerprint({
		steps: value.steps.map((step) => ({ approvers: step.approvers })),
		superceded_by: value.superceded_by
	});
};
const JsonObject = Schema.Record(Schema.String, Schema.Json);

/** The `JsonObject` predicate, built once: it is consulted for every operation value crossing the seam. */
const isJsonObject = Schema.is(JsonObject);
const isObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isObjectLike = Schema.is(
	Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
);
const isNumber = Schema.is(Schema.Number);
/** The requestor schema predicate, built once for reviewer-safe approval projections. */
const isSubject = Schema.is(Identity.Subject);

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

type ApprovalRoot = Readonly<{
	readonly collection: string;
	readonly id: string;
	readonly action: 'create' | 'update' | 'delete';
}>;

/** One row the hold covers: stamped `approval_id`, restored on refusal. */
type ApprovalLockedRow = Readonly<{ readonly collection: string; readonly id: string }>;

/**
 * What the engine hands over when policy routes a write to approval (RFC §4.8).
 *
 * The graph is committed provisionally by the engine in the same transaction the request row is
 * written in; this plan is the request's durable half: who asked, for what root, under which
 * resolved flow, and which rows the hold covers.
 */
type ApprovalHoldPlan = Readonly<{
	readonly effectId: EffectId;
	readonly subject: Identity.Subject;
	readonly root: ApprovalRoot;
	readonly approval: Schema.Json | undefined;
	readonly lockSet: ReadonlyArray<ApprovalLockedRow>;
	readonly browserMutation?: Schema.Json;
}>;

/** The request id and the one statement that persists it inside the engine's transaction. */
type ApprovalHold = Readonly<{
	readonly requestId: string;
	readonly statement: Statement;
}>;

/** The seal: an approved request, its lock set, and who asked. */
type ApprovalResume = Readonly<{
	readonly requestId: string;
	readonly subject: Identity.Subject;
	readonly root: ApprovalRoot;
	readonly lockSet: ReadonlyArray<ApprovalLockedRow>;
	readonly browserMutation?: Schema.Json;
}>;

/** The restore: a refused request and the rows to unwind. */
type ApprovalDiscard = Readonly<{
	readonly requestId: string;
	readonly subject: Identity.Subject;
	readonly root: ApprovalRoot;
	readonly resolution: 'rejected' | 'changes_requested' | 'withdrawn';
	readonly lockSet: ReadonlyArray<ApprovalLockedRow>;
	readonly browserMutation?: Schema.Json;
}>;

const StoredApprovalOperation = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	action: Schema.Literals(['create', 'update', 'delete']),
	subject: Identity.Subject,
	lockSet: Schema.Array(
		Schema.Struct({ collection: Schema.NonEmptyString, id: Schema.NonEmptyString })
	),
	browserMutation: Schema.optionalKey(Schema.Json)
});

/** A retry of the same root/effect rejoins the same durable request. */
export const approvalRequestId = (root: ApprovalRoot, effectId: EffectId): string =>
	deriveRecordId(`${root.collection}:${root.id}:${effectId}`);

export type Interface = Readonly<{
	/** Prepares the request row for the engine's transaction; nothing is written here. */
	readonly hold: (
		plan: ApprovalHoldPlan
	) => Effect.Effect<ApprovalHold, Database.FacilityError | ApprovalConflict>;
	/** Publishes the request's inbox projection once the engine has committed it. */
	readonly announce: (
		effectId: EffectId,
		requestId: string
	) => Effect.Effect<void, Database.FacilityError | ApprovalConflict>;
	/** Whether the subject may write under this request's hold (RFC §4.8). */
	readonly participant: (
		effectId: EffectId,
		subject: Identity.Subject,
		requestId: string
	) => Effect.Effect<boolean, Database.FacilityError | ApprovalConflict>;
	readonly resume: (
		effectId: EffectId,
		requestId: string
	) => Effect.Effect<ApprovalResume, Database.FacilityError | ApprovalConflict>;
	readonly discard: (
		effectId: EffectId,
		requestId: string
	) => Effect.Effect<ApprovalDiscard, Database.FacilityError | ApprovalConflict>;
	readonly decide: (
		effectId: EffectId,
		subject: Identity.Subject,
		state: Pick<ApprovalState, 'requestId'>,
		decision: 'approve' | 'reject' | 'request_changes' | 'supersede',
		reason?: string
	) => Effect.Effect<
		ApprovalState,
		ApprovalConflict | AccessControl.AccessDenied | Database.FacilityError
	>;
	readonly withdraw: (
		effectId: EffectId,
		subject: Identity.Subject,
		state: Pick<ApprovalState, 'requestId'>
	) => Effect.Effect<
		ApprovalState,
		ApprovalConflict | AccessControl.AccessDenied | Database.FacilityError
	>;
	/** Marks a refused request whose restore could not apply; the hold stays for an administrator. */
	readonly conflict: (
		effectId: EffectId,
		requestId: string,
		reason: string
	) => Effect.Effect<ApprovalState, ApprovalConflict | Database.FacilityError>;
	/** Reviewer-safe durable state; engine-only graph, subject and digest are available only internally. */
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
	readonly timeline: (
		effectId: EffectId,
		requestId: string
	) => Effect.Effect<
		ReadonlyArray<ApprovalTimelineEvent>,
		Database.FacilityError | ApprovalConflict
	>;
}>;

/** Identifies the approvals service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Approvals');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;
		const access = yield* AccessControl.Service;
		const queue = yield* TaskQueue.Service;
		const syncCommit = yield* SyncCommit.Service;
		const PublicationRow = Schema.Struct({
			before: Schema.NullOr(JsonObject),
			after: JsonObject,
			requestor_after: Schema.optionalKey(Schema.NullOr(JsonObject))
		});
		const publishProjection = Effect.fn('Approvals.publishProjection')(function* (
			effectId: EffectId,
			rows: ReadonlyArray<unknown>
		) {
			const changes: SyncChange[] = [];
			for (const row of rows) {
				const { before, after, requestor_after } = yield* Schema.decodeUnknownEffect(
					PublicationRow
				)(row).pipe(
					Effect.mapError(
						() =>
							new Database.FacilityError({
								operation: 'approval-publication',
								code: 'invalid-row',
								message: 'Approval transition did not return its durable routing snapshots.',
								retryable: false,
								outcome: 'known'
							})
					)
				);
				const id = Schema.decodeUnknownSync(Schema.String)(after['id']);
				changes.push(
					before === null
						? { collection: 'approval_request', id, operation: 'insert', after }
						: { collection: 'approval_request', id, operation: 'update', before, after }
				);
				if (requestor_after != null)
					changes.push({
						collection: 'requestor',
						id: Schema.decodeUnknownSync(Schema.String)(requestor_after['id']),
						operation: 'insert',
						after: requestor_after
					});
			}
			yield* syncCommit.publish(EffectId.make(`${effectId}:approval-projection`), { changes });
		});
		/** Resolves only the concrete configuration embedded when the flow was selected. */
		const approvalConfigurations = {
			resolve: (state: ApprovalState) => {
				if (state._tag !== 'Pending' || !isObject(state.operation)) return undefined;
				const embedded = Reflect.get(state.operation, 'approval');
				if (isResolvedApprovalConfiguration(embedded)) return embedded;
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
		const rawStatus = Effect.fn('Approvals.rawStatus')(function* (
			effectId: EffectId,
			requestId: string
		) {
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
			const state = isObjectLike(row) ? Reflect.get(row, 'state') : undefined;
			if (state === undefined) return undefined;
			return yield* decodeState(requestId, state);
		});
		const publicState = (state: ApprovalState): ApprovalState => {
			const stored = Option.getOrUndefined(Schema.decodeUnknownOption(JsonObject)(state.operation));
			if (stored === undefined) return state;
			const operation: Schema.Json = Object.fromEntries(
				Object.entries(stored).filter(
					([field]) => field !== 'subject' && field !== 'browserMutation'
				)
			);
			return { ...state, operation };
		};
		/** Reviewer-facing status never carries the requestor's subject. */
		const status = Effect.fn('Approvals.status')(function* (effectId: EffectId, requestId: string) {
			const state = yield* rawStatus(effectId, requestId);
			return state === undefined ? undefined : publicState(state);
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
			const current = yield* rawStatus(effectId, requestId);
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
			const requestId = isObjectLike(row) ? Reflect.get(row, 'id') : undefined;
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
						subjectId: aliased(auditTable.subject_id, 'subjectId'),
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
			followup?: ApprovalFollowup
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
								payload: aliased(jsonb(publicState(next)), 'payload')
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
							closed_at: excluded(approvalRequestTable.closed_at),
							closed_by: excluded(approvalRequestTable.closed_by),
							updated_at: dbNow(),
							row_version: increment(approvalRequestTable.row_version)
						}
					})
					.returning({
						id: approvalRequestTable.id,
						after: aliased(rowJson('approval_request'), 'after')
					})
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
			if (queued === undefined) {
				return composer
					.with(updated, audited, projected)
					.select({
						state: updated.state,
						before: aliased(rowJson('approval_request'), 'before'),
						after: projected.after
					})
					.from(updated)
					.innerJoin(projected, always())
					.leftJoin(approvalRequestTable, eq(approvalRequestTable.id, requestId));
			}
			return composer
				.with(updated, audited, projected, queued)
				.select({
					state: updated.state,
					before: aliased(rowJson('approval_request'), 'before'),
					after: projected.after
				})
				.from(updated)
				.innerJoin(projected, always())
				.leftJoin(approvalRequestTable, eq(approvalRequestTable.id, requestId));
		};
		const conflict = Effect.fn('Approvals.conflict')(function* (
			effectId: EffectId,
			requestId: string,
			reason: string
		) {
			const current = yield* rawStatus(effectId, requestId);
			if (
				current?._tag !== 'Rejected' &&
				current?._tag !== 'ChangesRequested' &&
				current?._tag !== 'Withdrawn'
			)
				return yield* new ApprovalConflict({
					requestId,
					reason: 'only a refused request may be marked conflicted'
				});
			const closedBy = current._tag === 'Withdrawn' ? current.withdrawnBy : current.decidedBy;
			const next: ApprovalState = {
				_tag: 'Conflicted',
				requestId,
				reason,
				...(current.operation === undefined ? {} : { operation: current.operation })
			};
			const projection = yield* projectionOf(next, closedBy);
			const updatedState = composer.$with('updated').as(
				composer
					.update(approvalStateTable)
					.set({ state: next })
					.where(
						and(
							eq(approvalStateTable.request_id, requestId),
							jsonTextEquals(approvalStateTable.state, '_tag', current._tag)
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
								subject_id: aliased(bound(closedBy), 'subject_id'),
								request_id: aliased(bound(requestId), 'request_id'),
								payload: aliased(jsonb(publicState(next)), 'payload')
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
							closed_at: excluded(approvalRequestTable.closed_at),
							closed_by: excluded(approvalRequestTable.closed_by),
							updated_at: dbNow(),
							row_version: increment(approvalRequestTable.row_version)
						}
					})
					.returning({
						id: approvalRequestTable.id,
						after: aliased(rowJson('approval_request'), 'after')
					})
			);
			const transition = composer
				.with(updatedState, audited, projected)
				.select({
					state: updatedState.state,
					before: aliased(rowJson('approval_request'), 'before'),
					after: projected.after
				})
				.from(updatedState)
				.innerJoin(projected, always())
				.leftJoin(approvalRequestTable, eq(approvalRequestTable.id, requestId));
			const updated = yield* executeBuilt(effectId, database, transition);
			if (updated.rows.length === 0)
				return yield* new ApprovalConflict({
					requestId,
					reason: 'approval conflict lost a competing state transition'
				});
			yield* publishProjection(effectId, updated.rows);
			return next;
		});
		/**
		 * The one statement that opens a request: durable state, audit, the inbox projection and the
		 * requestor link, each reading from the inserted state so a rejoined request writes nothing
		 * twice. The engine runs it inside the transaction that commits the held graph (RFC §4.8).
		 */
		const hold = Effect.fn('Approvals.hold')(function* (plan: ApprovalHoldPlan) {
			if (!isResolvedApprovalConfiguration(plan.approval))
				return yield* new ApprovalConflict({
					requestId: approvalRequestId(plan.root, plan.effectId),
					reason: 'approval requires one concrete resolved approval flow'
				});
			const requestId = approvalRequestId(plan.root, plan.effectId);
			const pending = yield* pendingForRecord(
				EffectId.make(`${plan.effectId}:approval-root-lock`),
				plan.root.collection,
				plan.root.id
			);
			if (pending !== undefined && pending.requestId !== requestId)
				return yield* new ApprovalConflict({
					requestId,
					reason: `${plan.root.collection} ${plan.root.id} is held by another approval request`
				});
			// The held row is the proposal (§4.8): the request carries what it governs, never a copy of
			// the values, which a participant's edit under the hold would only leave stale.
			const operation: Schema.Json = {
				collection: plan.root.collection,
				id: plan.root.id,
				action: plan.root.action,
				subject: plan.subject,
				approval: plan.approval,
				lockSet: plan.lockSet,
				...(plan.browserMutation === undefined ? {} : { browserMutation: plan.browserMutation })
			};
			const state: ApprovalState = { _tag: 'Pending', requestId, step: 0, operation };
			const projection = yield* projectionOf(state);
			const requestorId = deriveRecordId(`${requestId}:${plan.subject.userId}`);
			const insertedState = composer
				.$with('inserted')
				.as(
					composer
						.insert(approvalStateTable)
						.values({ request_id: requestId, tenant_id: plan.subject.tenantId, state })
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
								subject_id: aliased(bound(plan.subject.userId), 'subject_id'),
								request_id: aliased(bound(requestId), 'request_id'),
								payload: aliased(jsonb(publicState(state)), 'payload')
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
								superseder_teams: aliased(jsonb(projection.supersederTeams), 'superseder_teams'),
								closed_at: aliased(bound(projection.closedAt), 'closed_at'),
								closed_by: aliased(bound(projection.closedBy), 'closed_by')
							})
							.from(insertedState)
					)
					.onConflictDoNothing({ target: approvalRequestTable.id })
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
								user_id: aliased(bound(plan.subject.userId), 'user_id')
							})
							.from(insertedState)
							.innerJoin(projected, always())
					)
					.onConflictDoNothing({ target: requestorTable.id })
					.returning({ id: requestorTable.id })
			);
			const requestQuery = composer
				.with(insertedState, audited, projected, requestorProjected)
				.select({ state: insertedState.state })
				.from(insertedState);
			return { requestId, statement: toStatement(requestQuery.toSQL()) };
		});
		/** The inbox projection of one request, published as the inserts the hold statement made. */
		const announce = Effect.fn('Approvals.announce')(function* (
			effectId: EffectId,
			requestId: string
		) {
			const rows = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({
						before: aliased(sql`null::jsonb`, 'before'),
						after: aliased(rowJson('approval_request'), 'after'),
						requestor_after: aliased(rowJson('requestor'), 'requestor_after')
					})
					.from(approvalRequestTable)
					.leftJoin(requestorTable, eq(requestorTable.approval_request_id, requestId))
					.where(eq(approvalRequestTable.id, requestId))
			);
			if (rows.rows.length === 0)
				return yield* new ApprovalConflict({
					requestId,
					reason: 'the held request was not written with its graph'
				});
			yield* publishProjection(effectId, rows.rows);
		});
		/**
		 * Who may write under a hold (RFC §4.8): the requestor, an approver of the current step, a
		 * team named in `superceded_by`, or an administrator. Nobody else, and nobody may open a
		 * second request on a held row — that refusal is the engine's, before this is asked.
		 */
		const participant = Effect.fn('Approvals.participant')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			requestId: string
		) {
			if (subject.admin === true) return true;
			const current = yield* rawStatus(effectId, requestId);
			if (current?._tag !== 'Pending') return false;
			const operation = isJsonObject(current.operation) ? current.operation : undefined;
			const requestor = operation === undefined ? undefined : operation['subject'];
			if (isSubject(requestor) && requestor.userId === subject.userId) return true;
			return (
				decisionCapability(subject, current).allowed ||
				supersedeCapability(subject, current).allowed
			);
		});
		const storedOperation = (requestId: string, state: ApprovalState) =>
			Schema.decodeUnknownEffect(StoredApprovalOperation)(state.operation).pipe(
				Effect.mapError(
					() =>
						new ApprovalConflict({
							requestId,
							reason: 'the request does not carry the engine plan it was opened with'
						})
				)
			);
		const resume = Effect.fn('Approvals.resume')(function* (effectId: EffectId, requestId: string) {
			const current = yield* rawStatus(effectId, requestId);
			if (current?._tag !== 'Approved')
				return yield* new ApprovalConflict({
					requestId,
					reason: 'approval has not been approved'
				});
			const stored = yield* storedOperation(requestId, current);
			return {
				requestId,
				subject: stored.subject,
				root: { collection: stored.collection, id: stored.id, action: stored.action },
				lockSet: stored.lockSet,
				...(stored.browserMutation === undefined ? {} : { browserMutation: stored.browserMutation })
			};
		});
		const discard = Effect.fn('Approvals.discard')(function* (
			effectId: EffectId,
			requestId: string
		) {
			const current = yield* rawStatus(effectId, requestId);
			if (
				current?._tag !== 'Rejected' &&
				current?._tag !== 'ChangesRequested' &&
				current?._tag !== 'Withdrawn'
			)
				return yield* new ApprovalConflict({
					requestId,
					reason: 'approval was not refused'
				});
			const stored = yield* storedOperation(requestId, current);
			return {
				requestId,
				subject: stored.subject,
				root: { collection: stored.collection, id: stored.id, action: stored.action },
				resolution:
					current._tag === 'Rejected'
						? ('rejected' as const)
						: current._tag === 'ChangesRequested'
							? ('changes_requested' as const)
							: ('withdrawn' as const),
				lockSet: stored.lockSet,
				...(stored.browserMutation === undefined ? {} : { browserMutation: stored.browserMutation })
			};
		});
		return Service.of({
			hold,
			announce,
			participant,
			resume,
			discard,
			decide: Effect.fn('Approvals.decide')(function* (
				effectId,
				subject,
				state,
				decision,
				reason = ''
			) {
				const current = yield* rawStatus(effectId, state.requestId);
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
						followup
					)
				);
				if (updated.rows.length === 0)
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'approval decision lost a competing update'
					});
				yield* publishProjection(effectId, updated.rows);
				if (followup !== undefined)
					yield* queue.wake(
						EffectId.make(`${effectId}:approval-followup-wake`),
						yield* Clock.currentTimeMillis
					);
				return publicState(next);
			}),
			withdraw: Effect.fn('Approvals.withdraw')(function* (effectId, subject, state) {
				const current = yield* rawStatus(effectId, state.requestId);
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
				yield* publishProjection(effectId, updated.rows);
				return publicState(next);
			}),
			conflict,
			status,
			capabilities,
			timeline
		});
	})
);
