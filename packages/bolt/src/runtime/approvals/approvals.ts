import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import { sha256Text } from '@norbital-ai/std/reckon/hash';
import { Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import {
	readConsistencyStatements,
	READ_CONFLICT_MESSAGE,
	type ReadSnapshot
} from '#lib/runtime/collections/read-consistency.js';
import { ApprovalState, EffectId } from '@norbital-ai/bolt-protocol';
import { and, asc, desc, eq, exists, isNull, notExists } from 'drizzle-orm';
import { compileModelTable } from '#lib/authoring/model-introspection.js';
import { defineModel } from '#lib/authoring/models-schema.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { canonicalJson } from '#lib/canonical-json.js';
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
	jsonTextEquals,
	toStatement
} from '#lib/runtime/persistence.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as Identity from '#lib/runtime/identity/identity.js';

const {
	approval_request: approvalRequestTable,
	requestor: requestorTable,
	bolt_approvals: approvalStateTable,
	bolt_audit: auditTable,
	bolt_notifications: notificationTable,
	bolt_task: taskTable,
	bolt_collection_history: collectionHistoryTable
} = SYSTEM_MODEL_TABLES;

type ApprovalProjection = Readonly<{
	readonly collectionName: string;
	readonly recordId: string;
	readonly action: string;
	readonly status: string;
	readonly steps: Schema.Json;
	readonly approverTeams: Schema.Json;
	readonly supersederTeams: Schema.Json;
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
export const approvalFingerprint = (value: Schema.Json | undefined): string =>
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
const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);
const jsonObjectEquivalent = Schema.toEquivalence(JsonObject);
/** The requestor schema predicate, built once for reviewer-safe approval projections. */
const isSubject = Schema.is(Identity.Subject);
const subjectEquivalent = Schema.toEquivalence(Identity.Subject);

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

type ApprovedGate = Readonly<{
	readonly requestId: string;
	/** Exact digest supplied by `resume`; a re-prepared graph must reproduce it byte-for-byte. */
	readonly expectedReview: string;
}>;

/**
 * The engine's complete coupling to approvals at the end of PREPARE.
 *
 * One plan is one mutation root, even when `storedGraph` contains descendants or hook-issued writes.
 * A batch calls `gate` independently for each root, so held roots are excised while unrelated roots
 * can commit. The engine remains the only owner of graph execution.
 */
type ApprovalGatePlan = Readonly<{
	readonly effectId: EffectId;
	readonly subject: Identity.Subject;
	readonly root: ApprovalRoot;
	readonly storedGraph: Schema.Json;
	readonly proposedValues?: Readonly<Record<string, Schema.Json>>;
	readonly readSnapshots?: ReadonlyArray<ReadSnapshot>;
	readonly approval: Schema.Json | undefined;
	readonly review: Schema.Json | undefined;
	readonly approved?: ApprovedGate;
}>;

type ApprovalGateDecision =
	| Readonly<{ readonly _tag: 'Proceed'; readonly governingRequest?: string }>
	| Readonly<{ readonly _tag: 'Hold'; readonly requestId: string }>;

/** The payload a resume dispatcher feeds back through the collection engine's public mutate path. */
type ApprovalResume = Readonly<{
	readonly requestId: string;
	readonly subject: Identity.Subject;
	readonly storedGraph: Schema.Json;
	readonly approved: true;
	readonly expectedReview: string;
}>;

type ApprovalDiscard = Readonly<{
	readonly requestId: string;
	readonly root: ApprovalRoot;
	readonly resolution: 'rejected' | 'changes_requested' | 'withdrawn';
	readonly browserMutation?: Schema.Json;
}>;

const StoredApprovalGraph = Schema.Struct({
	version: Schema.Literal(1),
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	action: Schema.Literals(['create', 'update', 'delete']),
	browserMutation: Schema.optionalKey(Schema.Json)
});

/** A retry of the same root/effect rejoins the same durable request. */
export const approvalRequestId = (root: ApprovalRoot, effectId: EffectId): string =>
	deriveRecordId(`${root.collection}:${root.id}:${effectId}`);

/** Hashes the exact JSON bytes reviewed by the requestor, including snapshot strings verbatim. */
export const approvalReviewDigest = (review: Schema.Json | undefined): string =>
	`sha256:${sha256Text(JSON.stringify(review ?? null))}`;

const maskSnapshot = (
	invocation: AccessControl.Invocation,
	subject: Identity.Subject,
	collection: string,
	snapshot: string
): string => {
	try {
		const decoded: unknown = JSON.parse(snapshot);
		if (Array.isArray(decoded)) {
			return JSON.stringify(
				decoded.map((entry) =>
					isJsonObject(entry) ? invocation.mask(subject, 'read', collection, entry) : {}
				)
			);
		}
		return JSON.stringify(
			isJsonObject(decoded) ? invocation.mask(subject, 'read', collection, decoded) : {}
		);
	} catch {
		// A malformed prepared snapshot cannot be allowed to carry arbitrary bytes into the reviewer
		// surface. The original digest still makes resume fail when the engine re-prepares it.
		return '{}';
	}
};

/** Masks every stored row-shaped review snapshot under the requestor's frozen read grant. */
export const maskApprovalReview = (
	review: Schema.Json | undefined,
	invocation: AccessControl.Invocation,
	subject: Identity.Subject
): Schema.Json | undefined => {
	// `Schema.is` under this effect release does not narrow a union operand well enough for a spread,
	// so the object is decoded once and the typed record is what the rest of the function touches.
	const source = Option.getOrUndefined(Schema.decodeUnknownOption(JsonObject)(review));
	if (source === undefined) return review;
	const rows = Array.isArray(source['rows'])
		? source['rows'].map((value) => {
				const entry = Option.getOrUndefined(Schema.decodeUnknownOption(JsonObject)(value));
				if (entry === undefined) return value;
				const collection = entry['collection'];
				const snapshot = entry['snapshot'];
				return isString(collection) && isString(snapshot)
					? { ...entry, snapshot: maskSnapshot(invocation, subject, collection, snapshot) }
					: value;
			})
		: source['rows'];
	const relationships = Array.isArray(source['relationships'])
		? source['relationships'].map((value) => {
				const entry = Option.getOrUndefined(Schema.decodeUnknownOption(JsonObject)(value));
				if (entry === undefined) return value;
				const collection = entry['childCollection'];
				const snapshot = entry['snapshot'];
				return isString(collection) && isString(snapshot)
					? { ...entry, snapshot: maskSnapshot(invocation, subject, collection, snapshot) }
					: value;
			})
		: source['relationships'];
	return {
		...source,
		...(rows === undefined ? {} : { rows }),
		...(relationships === undefined ? {} : { relationships })
	};
};

export type Interface = Readonly<{
	readonly gate: (
		plan: ApprovalGatePlan
	) => Effect.Effect<ApprovalGateDecision, Database.FacilityError | ApprovalConflict>;
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
	/** Terminates an approved request whose reviewed graph can no longer be applied. */
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
			// Decoded once so the projection below spreads a typed record rather than a `Json` union.
			const stored = Option.getOrUndefined(Schema.decodeUnknownOption(JsonObject)(state.operation));
			if (stored === undefined) return state;
			const requestor = isSubject(stored['subject']) ? stored['subject'] : undefined;
			const collection = isString(stored['collection']) ? stored['collection'] : undefined;
			const policy = requestor === undefined ? undefined : access.invocation();
			const review =
				requestor === undefined || policy === undefined
					? stored['review']
					: maskApprovalReview(stored['review'], policy, requestor);
			const values =
				requestor === undefined ||
				policy === undefined ||
				collection === undefined ||
				!isJsonObject(stored['values'])
					? stored['values']
					: policy.mask(requestor, 'read', collection, stored['values']);
			const operation: Schema.Json = Object.fromEntries(
				Object.entries({
					...stored,
					...(review === undefined ? {} : { review }),
					...(values === undefined ? {} : { values })
				}).filter(
					([field]) => field !== 'storedGraph' && field !== 'subject' && field !== 'reviewDigest'
				)
			);
			return { ...state, operation };
		};
		/** Reviewer-facing status masks snapshots and never carries engine-only resume material. */
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
			if (!isString(requestId)) return undefined;
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
		/**
		 * The version this record must return to if the request is rejected.
		 *
		 * The newest history sequence *strictly before* the request opens - so a rejection lands on the
		 * state that existed before any of this began, not on whatever the last revision produced. A
		 * record with no history did not exist, which is why `null` is the honest answer and why
		 * rejecting a create deletes rather than restores.
		 *
		 * Sequence, never a timestamp: writes inside one transaction share `now()`, and the whole point
		 * is to separate the version before the request from the versions it produced.
		 */
		const anchorFor = Effect.fn('Approvals.anchorFor')(function* (
			effectId: EffectId,
			collection: string,
			recordId: string
		) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ sequence: collectionHistoryTable.sequence })
					.from(collectionHistoryTable)
					.where(
						and(
							eq(collectionHistoryTable.collection_name, collection),
							eq(collectionHistoryTable.record_id, recordId)
						)
					)
					.orderBy(desc(collectionHistoryTable.sequence))
					.limit(1)
			);
			const row = result.rows[0];
			const sequence = isObjectLike(row) ? Reflect.get(row, 'sequence') : undefined;
			return isNumber(sequence) ? sequence : null;
		});

		const projectionOf = Effect.fn('Approvals.projectionOf')(function* (
			state: ApprovalState,
			closedBy?: string
		) {
			const operation = state.operation;
			const fields = isJsonObject(operation) ? operation : {};
			const collectionName = isString(fields['collection']) ? fields['collection'] : 'unknown';
			const recordId = isString(fields['id']) ? fields['id'] : 'unknown';
			const action = isString(fields['action']) ? fields['action'] : 'update';
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
			const current = yield* rawStatus(effectId, requestId);
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
			const collection = isString(operation['collection']) ? operation['collection'] : undefined;
			const recordId = isString(operation['id']) ? operation['id'] : undefined;
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
			return next;
		});
		const persistRequest = Effect.fn('Approvals.persistRequest')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			requestId: string,
			operation: Schema.Json,
			lock?: ApprovalRecordLock,
			readSnapshots: ReadonlyArray<ReadSnapshot> = []
		) {
			const operationObject = Schema.decodeUnknownOption(JsonObject)(operation);
			if (
				operationObject._tag === 'None' ||
				!isResolvedApprovalConfiguration(operationObject.value['approval'])
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
			const inserted =
				readSnapshots.length === 0
					? yield* executeBuilt(effectId, database, requestQuery)
					: yield* database
							.execute(effectId, {
								_tag: 'Transaction',
								statements: [
									...readConsistencyStatements(readSnapshots, [
										'approval_request',
										...(lock == null ? [] : [lock.collection])
									]),
									toStatement(requestQuery.toSQL())
								]
							})
							.pipe(
								Effect.catch(
									(error): Effect.Effect<never, Database.FacilityError | ApprovalConflict> =>
										error.message.includes(READ_CONFLICT_MESSAGE)
											? Effect.fail(
													new ApprovalConflict({ requestId, reason: READ_CONFLICT_MESSAGE })
												)
											: Effect.fail(error)
								)
							);
			if (inserted.rows.length > 0) {
				return state;
			}
			const existing = yield* rawStatus(effectId, requestId);
			if (
				existing !== undefined &&
				isJsonObject(existing.operation) &&
				jsonObjectEquivalent(existing.operation, durableOperation)
			)
				return existing;
			if (existing !== undefined)
				return yield* new ApprovalConflict({
					requestId,
					reason: 'deterministic approval request id is already bound to another operation'
				});
			if (lock !== undefined)
				return yield* new ApprovalConflict({
					requestId,
					reason: `${lock.collection} ${lock.id} could not be locked for approval`
				});
			return yield* new ApprovalConflict({
				requestId,
				reason: 'approval request conflicted without a durable state'
			});
		});
		const resume = Effect.fn('Approvals.resume')(function* (effectId: EffectId, requestId: string) {
			const current = yield* rawStatus(effectId, requestId);
			if (current?._tag !== 'Approved')
				return yield* new ApprovalConflict({
					requestId,
					reason: 'approval has not been approved'
				});
			const operation = isJsonObject(current.operation) ? current.operation : undefined;
			const storedGraph = operation?.['storedGraph'];
			const expectedReview = operation?.['reviewDigest'];
			const storedSubject = operation?.['subject'];
			const subject = isSubject(storedSubject) ? storedSubject : undefined;
			if (storedGraph === undefined || !isString(expectedReview) || subject === undefined)
				return yield* new ApprovalConflict({
					requestId,
					reason: 'approved request does not contain a resumable engine plan'
				});
			return { requestId, subject, storedGraph, approved: true as const, expectedReview };
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
			const operation = isJsonObject(current.operation) ? current.operation : undefined;
			const stored = yield* Schema.decodeUnknownEffect(StoredApprovalGraph)(
				operation?.['storedGraph']
			).pipe(
				Effect.mapError(
					() =>
						new ApprovalConflict({
							requestId,
							reason: 'refused request does not contain a discardable engine plan'
						})
				)
			);
			if (
				operation?.['collection'] !== stored.collection ||
				operation?.['id'] !== stored.id ||
				operation?.['action'] !== stored.action
			)
				return yield* new ApprovalConflict({
					requestId,
					reason: 'refused request engine plan governs a different mutation root'
				});
			return {
				requestId,
				root: {
					collection: stored.collection,
					id: stored.id,
					action: stored.action
				},
				resolution:
					current._tag === 'Rejected'
						? ('rejected' as const)
						: current._tag === 'ChangesRequested'
							? ('changes_requested' as const)
							: ('withdrawn' as const),
				...(stored.browserMutation === undefined ? {} : { browserMutation: stored.browserMutation })
			};
		});
		const gate = Effect.fn('Approvals.gate')(function* (plan: ApprovalGatePlan) {
			if (plan.approval === undefined) {
				if (plan.approved !== undefined)
					return yield* new ApprovalConflict({
						requestId: plan.approved.requestId,
						reason: 'the reviewed mutation no longer resolves to an approval route'
					});
				return { _tag: 'Proceed' as const };
			}
			if (!isResolvedApprovalConfiguration(plan.approval)) {
				const requestId = plan.approved?.requestId ?? approvalRequestId(plan.root, plan.effectId);
				return yield* new ApprovalConflict({
					requestId,
					reason: 'approval gate requires one concrete resolved approval flow'
				});
			}
			if (plan.approved !== undefined) {
				const current = yield* rawStatus(plan.effectId, plan.approved.requestId);
				if (current?._tag !== 'Approved')
					return yield* new ApprovalConflict({
						requestId: plan.approved.requestId,
						reason: 'approval has not been approved'
					});
				const operation = isJsonObject(current.operation) ? current.operation : undefined;
				const storedSubject = operation?.['subject'];
				if (
					operation?.['collection'] !== plan.root.collection ||
					operation?.['id'] !== plan.root.id ||
					operation?.['action'] !== plan.root.action ||
					!isSubject(storedSubject) ||
					!subjectEquivalent(storedSubject, plan.subject)
				)
					return yield* new ApprovalConflict({
						requestId: plan.approved.requestId,
						reason: 'approved request governs a different mutation root'
					});
				const storedDigest = operation['reviewDigest'];
				const preparedDigest = approvalReviewDigest(plan.review);
				if (
					!isString(storedDigest) ||
					storedDigest !== plan.approved.expectedReview ||
					preparedDigest !== plan.approved.expectedReview
				)
					return yield* new ApprovalConflict({
						requestId: plan.approved.requestId,
						reason: 'the reviewed mutation graph changed while approval was pending'
					});
				return { _tag: 'Proceed' as const, governingRequest: plan.approved.requestId };
			}

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
			const reviewDigest = approvalReviewDigest(plan.review);
			const policy = access.invocation();
			const maskedReview = maskApprovalReview(plan.review, policy, plan.subject);
			const maskedProposedValues = policy.mask(
				plan.subject,
				'read',
				plan.root.collection,
				plan.proposedValues ?? {}
			);
			const operation: Schema.Json = {
				collection: plan.root.collection,
				id: plan.root.id,
				action: plan.root.action,
				// The inbox projection is a reviewer-facing snapshot too. The engine input remains whole in
				// `storedGraph`, which is consumed only by `resume` and never projected to approvers.
				values: maskedProposedValues,
				subject: plan.subject,
				approval: plan.approval,
				mode: 'declarative',
				storedGraph: plan.storedGraph,
				...(maskedReview === undefined ? {} : { review: maskedReview }),
				reviewDigest
			};
			const state = yield* persistRequest(
				plan.effectId,
				plan.subject,
				requestId,
				operation,
				plan.root.action === 'create'
					? undefined
					: { collection: plan.root.collection, id: plan.root.id },
				plan.readSnapshots
			);
			if (state._tag !== 'Pending')
				return yield* new ApprovalConflict({
					requestId,
					reason: 'approval gate rejoined a request that is no longer pending'
				});
			return { _tag: 'Hold' as const, requestId };
		});
		return Service.of({
			gate,
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
				return publicState(next);
			}),
			conflict,
			status,
			capabilities,
			timeline
		});
	})
);
