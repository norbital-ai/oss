import { Effect, Schema } from 'effect';
import type { TenantDbShape } from './db/tenant-db.ts';

const unacknowledged = new WeakMap<TenantDbShape, Set<string>>();
/** Operations whose terminal events are appended but whose receipts the next commit statement acknowledges. */
export const acknowledgements = (db: TenantDbShape): Set<string> => {
	let pending = unacknowledged.get(db);
	if (pending === undefined) unacknowledged.set(db, (pending = new Set()));
	return pending;
};
/** Acknowledgement follows a durable full external append, never just a prepared intent. */
export const acknowledgeAudit = (db: TenantDbShape, operation: string) =>
	db
		.returning(Schema.Struct({ erase: Schema.Boolean }), {
			text: `UPDATE bolt_audit_receipt SET acknowledged_at=clock_timestamp() WHERE operation=$1 AND acknowledged_at IS NULL AND expired_at IS NULL
		RETURNING EXISTS (SELECT 1 FROM bolt_audit_erase p WHERE p.operation=$1 OR EXISTS (
			SELECT 1 FROM bolt_history h WHERE h.operation=$1 AND bolt_history_matches(h.collection,h.meta,p.collection) AND h.record=p.record)) AS erase`,
			params: [operation]
		})
		.pipe(Effect.map((rows) => rows.some((row) => row.erase)));

/** Called only after a healthy host confirms the prepared event is absent; expiry makes no rollback claim. */
export const expireAudit = (db: TenantDbShape, operation: string) =>
	db
		.returning(Schema.Struct({ operation: Schema.String }), {
			text: `UPDATE bolt_audit_receipt SET expired_at=clock_timestamp()
		WHERE operation=$1 AND acknowledged_at IS NULL AND expired_at IS NULL
		AND expires_at<=clock_timestamp()
		RETURNING operation`,
			params: [operation]
		})
		.pipe(Effect.map((rows) => rows.length > 0));

/** Recovery history is retained until each overlapping operation is acknowledged or explicitly expired. */
export const drainAuditErases = Effect.fn('Audit.eraseHistory')(function* (db: TenantDbShape) {
	if (
		!(yield* db.value(Schema.Boolean, {
			text: 'SELECT EXISTS (SELECT 1 FROM bolt_audit_erase)',
			params: []
		}))
	)
		return;
	for (;;) {
		const [answer] = yield* db.transaction({
			// No host I/O occurs under this lock. Trigger inserts and concurrent drains wait for this bounded batch.
			lock: { tables: ['bolt_history'], mode: 'SHARE ROW EXCLUSIVE' },
			statements: [
				{
					text: `WITH ready AS MATERIALIZED (
	SELECT DISTINCT ON (p.collection,p.record) p.* FROM bolt_audit_erase p
	JOIN bolt_audit_receipt r ON r.operation=p.operation
	WHERE (r.acknowledged_at IS NOT NULL OR r.expired_at IS NOT NULL) AND NOT EXISTS (
		SELECT 1 FROM bolt_history h LEFT JOIN bolt_audit_receipt pending ON pending.operation=h.operation
		WHERE bolt_history_matches(h.collection,h.meta,p.collection) AND h.record=p.record AND h.operation IS NOT NULL
		AND pending.acknowledged_at IS NULL AND pending.expired_at IS NULL)
	ORDER BY p.collection,p.record,p.revision,p.operation,p.mode LIMIT 200),
removed AS (DELETE FROM bolt_history h USING ready p
	WHERE p.mode='remove' AND bolt_history_matches(h.collection,h.meta,p.collection) AND h.record=p.record AND h.revision<=p.revision
	AND NOT (p.keep_marker AND h.revision=p.revision) RETURNING h.record),
sanitised AS (UPDATE bolt_history h SET changes=h.changes-bolt_history_purge_fields(h.meta->>'schema',p.collection,p.purge) FROM ready p
	WHERE p.mode='anonymise' AND bolt_history_matches(h.collection,h.meta,p.collection) AND h.record=p.record AND h.revision<p.revision
	AND h.changes ?| bolt_history_purge_fields(h.meta->>'schema',p.collection,p.purge) AND (h.changes-bolt_history_purge_fields(h.meta->>'schema',p.collection,p.purge)<>'{}'::jsonb OR h.cause='erased') RETURNING h.record),
empty AS (DELETE FROM bolt_history h USING ready p
	WHERE p.mode='anonymise' AND bolt_history_matches(h.collection,h.meta,p.collection) AND h.record=p.record AND h.revision<p.revision
	AND h.cause<>'erased' AND h.changes ?| bolt_history_purge_fields(h.meta->>'schema',p.collection,p.purge) AND h.changes-bolt_history_purge_fields(h.meta->>'schema',p.collection,p.purge)='{}'::jsonb RETURNING h.record),
finished AS (DELETE FROM bolt_audit_erase p USING ready r
	WHERE p.operation=r.operation AND p.collection=r.collection AND p.record=r.record AND p.mode=r.mode RETURNING p.record)
SELECT count(*)::int AS n FROM finished`,
					params: []
				}
			]
		});
		if (Number(answer?.rows[0]?.['n'] ?? 0) === 0) return;
	}
});
