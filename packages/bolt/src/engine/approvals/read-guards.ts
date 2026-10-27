// Native read plans persisted only after a provisional commit; guest flow output never supplies them.
import { Schema } from 'effect';
import type { Sql } from '../contracts.ts';
import { inline } from '../db/wire.ts';
import { Chain, digestOf, type ReadGuards } from '../write/sql.ts';

export const StoredReadGuards = Schema.Struct({
	sourceEpoch: Schema.String,
	tables: Schema.Array(Schema.String),
	fingerprints: Schema.Array(
		Schema.Struct({
			sql: Schema.Struct({ text: Schema.String, params: Schema.Array(Schema.Json) }),
			digest: Schema.String
		})
	)
});
export type StoredReadGuards = typeof StoredReadGuards.Type;

/** Initial admission never replaces an existing baseline on an idempotent retry. Decisions refresh only after validation. */
export function readGuardBaseline(
	requestId: string,
	guards: ReadGuards,
	sourceEpoch: string,
	refresh?: string
): Sql {
	const c = new Chain();
	c.cte('idem', 'SELECT 1 AS active');
	const fingerprints = guards.fingerprints.map(
		(fingerprint) =>
			`jsonb_build_object('sql', ${c.p({ text: fingerprint.sql.text, params: fingerprint.sql.params })}::jsonb, 'digest', ${digestOf(inline(fingerprint.sql))})`
	);
	const baseline = `jsonb_build_object('sourceEpoch', ${c.p(sourceEpoch)}::text, 'tables', ${c.p(guards.tables)}::jsonb, 'fingerprints', jsonb_build_array(${fingerprints.join(', ')}))`;
	const id = c.p(requestId);
	const replace =
		refresh === undefined
			? " AND NOT (route ? '__boltReadGuards')"
			: ` AND route ->> '__boltReadGuardRefresh' = ${c.p(refresh)}`;
	c.cte(
		'read_guard_baseline',
		`UPDATE bolt_approvals SET route = jsonb_set(route - '__boltReadGuardRefresh', '{__boltReadGuards}', ${baseline})
WHERE id::text = ${id}${replace} RETURNING id`
	);
	c.assert(
		`(SELECT count(*) FROM read_guard_baseline) = 1 OR EXISTS (SELECT 1 FROM bolt_approvals WHERE id::text = ${id} AND route ? '__boltReadGuards')`,
		'conflict',
		JSON.stringify({ model: 'approval_request', ids: [requestId] })
	);
	return c.sql('(SELECT count(*) FROM read_guard_baseline)::int AS updated');
}
