import type { Sql } from '../contracts.ts';
import type { WriteContext } from '../schema/audit.ts';

/** The session's write buffers, created on demand by every write (and up front by a host that pools sessions). */
export const CAPTURE_TABLES: readonly string[] = [
	'CREATE TEMP TABLE IF NOT EXISTS bolt_write_context (token text PRIMARY KEY, context jsonb NOT NULL, fresh boolean NOT NULL DEFAULT false, request uuid, authorized uuid, answer jsonb) ON COMMIT DELETE ROWS',
	"CREATE TEMP TABLE IF NOT EXISTS bolt_write_targets (token text NOT NULL, record_key text NOT NULL, direct boolean NOT NULL, erased boolean NOT NULL, restored int, anonymise jsonb NOT NULL DEFAULT '[]', PRIMARY KEY (token,record_key)) ON COMMIT DELETE ROWS",
	'CREATE TEMP TABLE IF NOT EXISTS bolt_changes (seq bigint GENERATED ALWAYS AS IDENTITY, token text NOT NULL, c text NOT NULL, id text NOT NULL, revision int NOT NULL, op text NOT NULL, cause text NOT NULL, erased boolean NOT NULL, o jsonb, n jsonb) ON COMMIT DELETE ROWS',
	'CREATE TEMP TABLE IF NOT EXISTS bolt_erased (token text NOT NULL, c text NOT NULL, id text NOT NULL, PRIMARY KEY (token,c,id)) ON COMMIT DELETE ROWS',
	'CREATE TEMP TABLE IF NOT EXISTS bolt_origins (token text NOT NULL, c text NOT NULL, id text NOT NULL, revision int NOT NULL, op text NOT NULL, cause text NOT NULL, erased boolean NOT NULL, PRIMARY KEY (token,c,id,revision)) ON COMMIT DELETE ROWS'
];

/**
 * Private native buffers: session temp tables created once per connection (`IF NOT EXISTS` also covers a pooler handing
 * out another backend), emptied at every commit, so no audit payload outlives its transaction and no write pays DDL.
 */
export const captureStart = (
	context: WriteContext,
	actor: string | null,
	anonymise: Readonly<Record<string, readonly string[]>> = {}
): readonly Sql[] => {
	const { direct, erased, restored, ...metadata } = context;
	const directKeys = new Set(direct),
		erasedKeys = new Set(erased);
	const targets = [
		...new Set([...direct, ...erased, ...Object.keys(restored ?? {}), ...Object.keys(anonymise)])
	].map((key) => ({
		key,
		direct: directKeys.has(key),
		erased: erasedKeys.has(key),
		restored: restored?.[key] ?? null,
		anonymise: anonymise[key] ?? []
	}));
	// two statements, two round trips: the parameterless buffers and their reset in one simple-protocol text, then the
	// context, targets and settings in one statement
	return [
		{
			// an earlier act in the same transaction may have left its buffers; a plain delete, so no write pays DDL
			text: [
				...CAPTURE_TABLES,
				'WITH a AS (DELETE FROM pg_temp.bolt_changes), b AS (DELETE FROM pg_temp.bolt_erased), c AS (DELETE FROM pg_temp.bolt_origins), d AS (DELETE FROM pg_temp.bolt_write_targets) DELETE FROM pg_temp.bolt_write_context'
			].join(';\n'),
			params: []
		},
		{
			text: `WITH context AS (INSERT INTO pg_temp.bolt_write_context (token,context) VALUES ($1,$2::jsonb)),
	targets AS (INSERT INTO pg_temp.bolt_write_targets (token,record_key,direct,erased,restored,anonymise) SELECT $1,x.key,x.direct,x.erased,x.restored,x.anonymise FROM jsonb_to_recordset($3::jsonb) x(key text,direct boolean,erased boolean,restored int,anonymise jsonb))
	SELECT set_config('bolt.write',$4,true), set_config('store.write',$5,true)`,
			params: [
				context.token,
				JSON.stringify(metadata),
				JSON.stringify(targets),
				JSON.stringify({ token: context.token }),
				JSON.stringify({ mode: context.mode, actor, at: context.now })
			]
		}
	];
};

/** Each record's earliest pre-image and final image, independent of how many native RI mutations reached it. */
export const netRows = (source: string): string => `SELECT last.c,last.id,last.revision,
	CASE WHEN first.o IS NULL THEN 'create' WHEN last.n IS NULL THEN 'delete' ELSE 'update' END::text AS op,
	CASE WHEN flags.direct THEN CASE WHEN flags.erased THEN 'erased' ELSE 'direct' END
		WHEN flags.cascade THEN 'cascade' ELSE 'derived' END::text AS cause,
	flags.erased,first.o,last.n,flags.cascade AS cascaded
FROM (SELECT DISTINCT ON (c,id) * FROM ${source} ORDER BY c,id,revision,seq) first
JOIN (SELECT DISTINCT ON (c,id) * FROM ${source} ORDER BY c,id,revision DESC,seq DESC) last USING(c,id)
JOIN (SELECT c,id,bool_or(cause IN ('direct','erased')) AS direct,
	bool_or(cause='cascade') AS cascade,bool_and(erased) AS erased FROM ${source} GROUP BY c,id) flags USING(c,id)
WHERE first.o IS NOT NULL OR last.n IS NOT NULL`;

/** Link every actual history revision, clear the native buffers and return the finalized receipt. */
export const captureFinish = (token: string, decision: boolean): Sql => ({
	text: `WITH changes AS (DELETE FROM pg_temp.bolt_changes WHERE token=$1 RETURNING *),
	linked AS (UPDATE bolt_history h SET request=context.request FROM changes x,pg_temp.bolt_write_context context
		WHERE context.token=$1 AND h.request IS DISTINCT FROM context.request
		AND h.collection=x.c AND h.record=CASE WHEN x.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN x.id::uuid END
		AND h.revision=x.revision RETURNING h.record),
	erased AS (DELETE FROM pg_temp.bolt_erased WHERE token=$1),
	origins AS (DELETE FROM pg_temp.bolt_origins WHERE token=$1),
	targets AS (DELETE FROM pg_temp.bolt_write_targets WHERE token=$1),
	context AS (DELETE FROM pg_temp.bolt_write_context WHERE token=$1 RETURNING answer),
	reset AS MATERIALIZED (SELECT set_config('bolt.write','',true),set_config('store.write','',true))
	SELECT answer->'outcome' AS outcome,answer->'captured' AS captured,answer->>'next_due' AS next_due,
	answer->'changed_instances' AS changed_instances,(answer->>'read_guards_applied')::boolean AS read_guards_applied
	${decision ? ",(answer->>'approval_decided')::int AS approval_decided" : ''}
	FROM context CROSS JOIN reset`,
	params: [token]
});
