// The host intent is durable before acquisition; the tenant keeps only correlation, never an audit payload outbox.
import { Array as EffectArray, Clock, Effect, Predicate, Result, Schema } from 'effect';

import type { AuditActor, AuditEvent, DbError } from '@norbital-ai/host-api';
import type { EngineActor } from './contracts.ts';
import type { Json } from '../decl/values.ts';
import type { TenantDbShape } from './db/tenant-db.ts';
import { Audit, AuditRecoveryActive, requestAuditRecovery } from './audit.ts';
import { AuditMutation, type AuditCommitted } from './audit-context.ts';
import { acknowledgeAudit, acknowledgements, drainAuditErases, expireAudit } from './audit-retention.ts';
import { BoltError } from '../protocol/errors.ts';

const jsonPayload = (value: unknown) =>
	Effect.try({
		try: () => JSON.stringify(value),
		catch: (error) => BoltError.make('invalid_input', 'facility', String(error))
	}).pipe(
		Effect.flatMap((value) =>
			Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(value)
		),
		Effect.mapError((error) =>
			error instanceof BoltError ? error : BoltError.make('invalid_input', 'facility', String(error))
		)
	);
export const auditActor = (actor: EngineActor): AuditActor => ({
	kind: actor.kind,
	// a person's handle as of the event; the audit view names them by their current directory name when it has one
	label: actor.kind === 'member' ? (actor.email ?? actor.phone) : null,
	id:
		actor.kind === 'member'
			? actor.id
			: actor.kind === 'api_key'
				? actor.key
				: actor.kind === 'system'
					? actor.run
					: actor.kind === 'visitor'
						? actor.visitor
						: actor.sender
});
export type AuditIntent = {
	readonly category: AuditEvent['category'];
	readonly action: string;
	readonly actor: AuditActor;
	readonly payload: Json;
	readonly invocation?: string;
	readonly run?: string;
	readonly approval?: string;
	readonly outcomeKey?: string;
	readonly digest?: string;
};
export const prepareAudit = Effect.fn('Audit.prepare')(function* (
	intent: AuditIntent,
	acknowledge: readonly string[] = []
) {
	const audit = yield* Audit;
	if (audit.mode === 'disabled')
		return yield* BoltError.make(
			'unavailable',
			'facility',
			'An audit store is required for this mutation.'
		);
	const at = new Date(yield* Clock.currentTimeMillis).toISOString();
	const operation_id = yield* audit.uuid;
	const event: AuditEvent = {
		id: `${operation_id}:prepared`,
		operation_id,
		at,
		category: intent.category,
		action: intent.action,
		status: 'prepared',
		actor: intent.actor,
		subject: null,
		invocation: intent.invocation ?? null,
		transaction: null,
		run: intent.run ?? null,
		approval: intent.approval ?? null,
		payload: intent.payload
	};
	yield* audit.append([event]);
	const stored = yield* audit.detail(event.id);
	if (
		stored === null ||
		stored.id !== event.id ||
		stored.operation_id !== operation_id ||
		stored.status !== 'prepared' ||
		!Number.isFinite(Date.parse(stored.recorded_at))
	)
		return yield* BoltError.make(
			'bad_answer',
			'facility',
			'The audit store did not retain its prepared event and recording time.'
		);
	const committed: AuditMutation['committed'] = {};
	return {
		event,
		recorded_at: stored.recorded_at,
		...(intent.outcomeKey === undefined ? {} : { outcomeKey: intent.outcomeKey }),
		...(intent.digest === undefined ? {} : { digest: intent.digest }),
		...(intent.run === undefined ? {} : { run: intent.run }),
		...(intent.approval === undefined ? {} : { approval: intent.approval }),
		acknowledge,
		committed
	} satisfies AuditMutation;
});
const History = Schema.Struct({
	model: Schema.String,
	id: Schema.String,
	revision: Schema.Number,
	at: Schema.String,
	actor: Schema.NullOr(Schema.String),
	op: Schema.String,
	cause: Schema.String,
	old: Schema.NullOr(Schema.Json),
	new: Schema.NullOr(Schema.Json)
});
const Receipt = Schema.Struct({
	at: Schema.String,
	outcome: Schema.NullOr(Schema.Json),
	key_reuse: Schema.Boolean,
	acknowledged: Schema.Boolean,
	expired: Schema.Boolean,
	due: Schema.Boolean,
	records: Schema.Array(History)
});
const statusOf = (value: unknown): AuditEvent['status'] => {
	const result = Predicate.hasProperty(value, 'outcome') ? value.outcome : value;
	if (Predicate.hasProperty(result, 'kind')) {
		if (
			result.kind === 'committed' ||
			result.kind === 'pending_approval' ||
			result.kind === 'refused' ||
			result.kind === 'conflict' ||
			result.kind === 'unknown'
		)
			return result.kind;
	}
	return 'committed';
};
/** Recovery scans unresolved host intents, so late tenant commits cannot fall behind a sequence checkpoint. */
export const settleAudit = Effect.fn('Audit.settle')(function* (
	db: TenantDbShape,
	event: AuditEvent
) {
	const receipt = yield* db.one(Receipt, {
		// Receipt and images share one snapshot: an acknowledgement may permit a concurrent history purge.
		text: `WITH receipt AS (SELECT r.at::text AS at,o.outcome,coalesce(r.digest IS NOT NULL AND i.digest IS DISTINCT FROM r.digest,false) AS key_reuse,
		r.acknowledged_at IS NOT NULL AS acknowledged,r.expired_at IS NOT NULL AS expired,
		r.expires_at<=clock_timestamp() AS due
		FROM bolt_audit_receipt r LEFT JOIN bolt_idem i ON i.key=r.outcome_key
		LEFT JOIN bolt_idem_outcome o ON o.key=i.key WHERE r.operation=$1),
		history AS (SELECT h.collection AS model,h.record::text AS id,h.revision,h.at::text AS at,h.actor,h.op,h.cause,
		CASE WHEN h.op='create' THEN NULL ELSE (SELECT coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) - ARRAY['revision','updated_at','updated_by'] FROM
		(SELECT DISTINCT ON(x.key) x.key,x.value FROM bolt_history p CROSS JOIN LATERAL jsonb_each(p.changes) x WHERE p.collection=h.collection AND p.record=h.record AND p.revision<h.revision ORDER BY x.key,p.revision DESC) e)
		|| coalesce((SELECT p.meta FROM bolt_history p WHERE p.collection=h.collection AND p.record=h.record AND p.revision<h.revision ORDER BY p.revision DESC LIMIT 1),'{}'::jsonb) END AS old,
		CASE WHEN h.op='delete' THEN NULL ELSE (SELECT coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) - ARRAY['revision','updated_at','updated_by'] FROM
		(SELECT DISTINCT ON(x.key) x.key,x.value FROM bolt_history p CROSS JOIN LATERAL jsonb_each(p.changes) x WHERE p.collection=h.collection AND p.record=h.record AND p.revision<=h.revision ORDER BY x.key,p.revision DESC) e) || h.meta END AS new
		FROM bolt_history h WHERE h.operation=$1 AND NOT (SELECT acknowledged OR expired FROM receipt))
		SELECT receipt.*,coalesce((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.model,h.id,h.revision) FROM history h),'[]'::jsonb) AS records FROM receipt`,
		params: [event.operation_id]
	});
	if (receipt._tag === 'None') return false;
	if (receipt.value.acknowledged || receipt.value.expired) return true;
	if (
		receipt.value.due &&
		(yield* (yield* Audit).detail(`${event.operation_id}:prepared`)) === null
	) {
		if (yield* expireAudit(db, event.operation_id)) yield* drainAuditErases(db);
		return true;
	}
	const status = yield* appendTerminal(event, {
		outcome: receipt.value.key_reuse
			? { kind: 'refused', code: 'key_reuse', message: 'This key was used for a different request.' }
			: receipt.value.outcome,
		records: receipt.value.records,
		committedAt: receipt.value.at
	});
	// an unknown commit stays pending for recovery to settle later
	if (status === 'unknown') yield* requestAuditRecovery(yield* Audit);
	else if (yield* acknowledgeAudit(db, event.operation_id)) yield* drainAuditErases(db);
	return true;
});
/** The row events and the terminal event of a committed operation, appended together; answers its status. */
const appendTerminal = Effect.fn('Audit.appendTerminal')(function* (
	event: AuditEvent,
	settled: { readonly outcome: Json; readonly records: readonly (typeof History.Type)[]; readonly committedAt: string }
) {
	const { outcome, committedAt } = settled;
	const written = settled.records;
	const status = outcome === null ? 'committed' : statusOf(outcome);
	const terminal: AuditEvent = {
		...event,
		id: `${event.operation_id}:${status === 'unknown' ? 'unknown' : 'terminal'}`,
		status,
		payload: {
			request: event.payload,
			outcome,
			records: written,
			committedAt
		}
	};
	// the request rides on a row event only when it wrote that one row: a bulk write's request is the terminal event's
	// alone, as copying it into each of its N row events is N² bytes (a 1,700-row import overran its 2 s of CPU)
	const rows: AuditEvent[] = written.map((row) => ({
		...event,
		id: `${event.operation_id}:row:${row.model}:${row.id}:${row.revision}`,
		action: `${row.model}.${row.op}`,
		status,
		subject: { model: row.model, id: row.id, revision: row.revision },
		payload: 
			written.length === 1 ? { request: event.payload, change: row } : { change: row }
		
	}));
	yield* (yield* Audit).append([...rows, terminal]);
	return status;
});
/**
 * A commit statement answered its own receipt and images, so its terminal event needs no read. Its acknowledgement
 * rides on the next commit statement (an erasure's, whose purge waits for it, follows at once); recovery acknowledges
 * any left when the process stops first.
 */
const appendCommitted = Effect.fn('Audit.appendCommitted')(function* (
	db: TenantDbShape,
	event: AuditEvent,
	committed: AuditCommitted
) {
	yield* appendTerminal(event, {
		outcome: committed.outcome,
		records: committed.records.map((row) => ({
			model: row.model,
			id: row.id,
			revision: row.revision,
			at: committed.at,
			actor: committed.actor,
			op: row.op,
			cause: row.cause,
			old: row.old,
			new: row.new
		})),
		committedAt: committed.committedAt
	});
	if (!committed.erase) acknowledgements(db).add(event.operation_id);
	else if (yield* acknowledgeAudit(db, event.operation_id)) yield* drainAuditErases(db);
	return true;
});
export const recoverAudit = Effect.fn('Audit.recover')(
	function* (db: TenantDbShape) {
		const audit = yield* Audit;
		if (audit.mode === 'disabled') return false;
		let after: string | undefined;
		do {
			const page = yield* audit.pending({ limit: 200, ...(after === undefined ? {} : { after }) });
			for (const event of page.rows) yield* settleAudit(db, event);
			after = page.next ?? undefined;
		} while (after !== undefined);
		// A process can stop after external append but before local acknowledgement; the host no longer lists that intent.
		let operation: string | undefined;
		for (;;) {
			const receipts = yield* db.rows(
				Schema.Struct({ operation: Schema.String, at: Schema.String, due: Schema.Boolean }),
				{
					text: `SELECT operation,at::text AS at,
			expires_at<=clock_timestamp() AS due
			FROM bolt_audit_receipt WHERE acknowledged_at IS NULL AND expired_at IS NULL
			AND ($1::text IS NULL OR operation>$1) ORDER BY operation LIMIT 200`,
					params: [operation ?? null]
				}
			);
			for (const receipt of receipts) {
				const terminal = yield* audit.detail(`${receipt.operation}:terminal`);
				if (
					terminal !== null &&
					terminal.status !== 'unknown' &&
					terminal.status !== 'prepared' &&
					Predicate.hasProperty(terminal.payload, 'committedAt') &&
					terminal.payload.committedAt === receipt.at &&
					Predicate.hasProperty(terminal.payload, 'records') &&
					EffectArray.isArray<typeof terminal.payload.records>(terminal.payload.records)
				)
					yield* acknowledgeAudit(db, receipt.operation);
				else if (receipt.due && (yield* audit.detail(`${receipt.operation}:prepared`)) === null)
					yield* expireAudit(db, receipt.operation);
			}
			operation = receipts.at(-1)?.operation;
			if (receipts.length < 200) break;
		}
		yield* drainAuditErases(db);
		// A missing receipt remains unresolved: a commit may still become visible after an interrupted reply.
		if ((yield* audit.pending({ limit: 1 })).rows.length > 0) return true;
		return yield* db.value(Schema.Boolean, {
			text: `SELECT EXISTS (SELECT 1 FROM bolt_audit_receipt WHERE acknowledged_at IS NULL AND expired_at IS NULL)
		OR EXISTS (SELECT 1 FROM bolt_audit_erase) AS unresolved`,
			params: []
		});
	},
	(effect) => effect.pipe(Effect.provideService(AuditRecoveryActive, true))
);
/**
 * Runs `effect` as one audited operation. `issued`, when given, says whether `effect` sent a statement that may carry the
 * operation's receipt: without one, nothing in the tenant can settle it, so its terminal event is appended unread.
 */
export const audited = <A, E, R>(
	db: TenantDbShape,
	intent: AuditIntent,
	effect: Effect.Effect<A, E, R>,
	issued?: () => boolean
): Effect.Effect<A, E | BoltError | DbError, R> =>
	Effect.gen(function* () {
		if ((yield* AuditMutation) !== undefined) return yield* effect;
		const pending = acknowledgements(db);
		const operation = yield* prepareAudit(intent, [...pending]);
		// Recovery wakes only for an operation this fiber leaves unsettled (failed, unknown or interrupted): a settled
		// one has nothing to recover.
		let settled = false;
		const audit = yield* Audit;
		return yield* Effect.gen(function* () {
			const result = yield* Effect.result(
				effect.pipe(Effect.provideService(AuditMutation, operation))
			);
			const committed = operation.committed.value;
			// the statement that committed acknowledged the earlier operations it carried
			if (committed !== undefined && !committed.erase) for (const id of operation.acknowledge ?? []) pending.delete(id);
			const resolved = yield* (committed !== undefined
				? appendCommitted(db, operation.event, committed)
				: issued?.() === false
					? Effect.succeed(false)
					: settleAudit(db, operation.event)
			).pipe(Effect.catch((error) => Effect.andThen(Effect.logWarning(error), Effect.succeed(undefined))));
			// settleAudit wakes recovery itself for an unknown commit
			if (resolved === true) settled = true;
			if (resolved === false) {
				const unknown =
					Result.isFailure(result) &&
					Predicate.hasProperty(result.failure, 'sqlstate') &&
					typeof result.failure.sqlstate === 'string' &&
					(result.failure.sqlstate.startsWith('08') ||
						(Predicate.hasProperty(result.failure, 'outcome_unknown') && result.failure.outcome_unknown === true));
				const payload = yield* jsonPayload({
					request: intent.payload,
					...(Result.isFailure(result)
						? { error: String(result.failure) }
						: { outcome: result.success })
				});
				const status: AuditEvent['status'] = unknown
					? 'unknown'
					: Result.isFailure(result)
						? 'failed'
						: statusOf(result.success);
				const event: AuditEvent = {
					...operation.event,
					id: `${operation.event.operation_id}:${status === 'unknown' ? 'unknown' : 'terminal'}`,
					status,
					payload
				};
				yield* audit.append([event]).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							settled = status !== 'unknown';
						})
					),
					Effect.catch((error) => Effect.logWarning(error))
				);
			}
			return Result.isFailure(result) ? yield* Effect.fail(result.failure) : result.success;
		}).pipe(
			Effect.ensuring(Effect.suspend(() => (settled ? Effect.void : requestAuditRecovery(audit))))
		);
	});
