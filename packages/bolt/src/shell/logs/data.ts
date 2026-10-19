// Administrator event-log queries, including cursor paging and a gap-free tail.
import { Effect, Schema } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import type { Authority } from '../../engine/contracts.ts';
import type { TenantDbShape } from '../../engine/db/tenant-db.ts';
import { requireAdmin } from '../../engine/identity/session.ts';
import type { Json } from '../../decl/values.ts';

const q = (text: string, ...params: Json[]) => ({ text, params });

const decode = <A>(schema: Schema.Decoder<A>, rows: unknown) =>
	Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
		Effect.mapError((e) => BoltError.make('internal', 'decode', String(e)))
	);

export type LogLevel = 'info' | 'warn' | 'error';
export type LogRow = {
	id: string;
	at: string;
	severity: LogLevel;
	event: string;
	invocation: string;
	run: string | null;
	conversation: string | null;
	turn: string | null;
	attributes: Json;
};
const LogRow = Schema.Struct({
	id: Schema.String,
	at: Schema.String,
	severity: Schema.Literals(['info', 'warn', 'error']),
	event: Schema.String,
	invocation: Schema.String,
	run: Schema.NullOr(Schema.String),
	conversation: Schema.NullOr(Schema.String),
	turn: Schema.NullOr(Schema.String),
	attributes: Schema.Json
});
export type LogQuery = {
	before?: string;
	after?: string;
	/** exactly this severity */
	level?: LogLevel;
	/** this severity or worse */
	min?: LogLevel;
	text?: string;
	conversation?: string;
	run?: string;
	/** the automation's runs' events and its console lines */
	automation?: string;
	/** instants bounding `at`: `since` inclusive, `until` exclusive */
	since?: string;
	until?: string;
	/** rows per page, 1 to 200 (default 200) */
	limit?: number;
};
const LOG_PAGE = 200;
const RANK: { readonly [l in LogLevel]: number } = { info: 0, warn: 1, error: 2 };

/**
 * The workspace log (§5.12, admins only): one page of `sys_event`, newest first, keyed by its identity column. `before`
 * pages to older rows, `after` follows the tail; `level` (or `min`), `text` (event name or attributes), `conversation`,
 * `run`, `automation` and the `since`/`until` window narrow it.
 */
export const events = Effect.fn('shell.events')(function* (
	db: TenantDbShape,
	auth: Authority,
	x: LogQuery
) {
	const refusal = requireAdmin(auth);
	if (refusal !== null) return yield* Effect.fail(refusal);
	const id = (v: string | undefined) => (v !== undefined && /^\d{1,18}$/.test(v) ? v : null);
	const given = (v: string | undefined) => (v === undefined || v === '' ? null : v);
	const bad = [x.since, x.until].find(
		(v) => given(v) !== null && Number.isNaN(Date.parse(v ?? ''))
	);
	if (bad !== undefined)
		return yield* Effect.fail(
			BoltError.make('invalidInput', 'decode', `'${bad}' is not an instant`)
		);
	const limit = Number.isFinite(x.limit)
		? Math.min(Math.max(1, Math.trunc(x.limit ?? 0)), LOG_PAGE)
		: LOG_PAGE;
	const tail = id(x.after);
	const levels =
		x.min !== undefined
			? (['info', 'warn', 'error'] as const).filter((l) => RANK[l] >= RANK[x.min ?? 'info'])
			: x.level !== undefined
				? [x.level]
				: null;
	const [rows] = yield* db.read([
		q(
			`SELECT id::text AS id, at::text AS at, severity, event, invocation, run, conversation, turn, attributes FROM sys_event
		WHERE ($1::bigint IS NULL OR id < $1::bigint) AND ($2::bigint IS NULL OR id > $2::bigint)
			AND ($3::jsonb IS NULL OR severity IN (SELECT jsonb_array_elements_text($3::jsonb)))
			AND ($4::text IS NULL OR strpos(lower(event), lower($4)) > 0 OR strpos(lower(attributes::text), lower($4)) > 0)
			AND ($5::text IS NULL OR conversation = $5) AND ($6::text IS NULL OR run = $6)
			AND ($7::text IS NULL OR attributes->>'automation' = $7 OR EXISTS (SELECT 1 FROM sys_run r WHERE r.id = sys_event.run AND r.automation = $7))
			AND ($8::timestamptz IS NULL OR at >= $8::timestamptz) AND ($9::timestamptz IS NULL OR at < $9::timestamptz)
		ORDER BY sys_event.id ${tail === null ? 'DESC' : 'ASC'} LIMIT ${limit}`,
			id(x.before),
			tail,
			levels === null ? null : JSON.stringify(levels),
			given(x.text),
			given(x.conversation),
			given(x.run),
			given(x.automation),
			given(x.since),
			given(x.until)
		)
	]);
	// the tail reads forward from `after` so a burst larger than a page leaves no gap; the answer is newest first either way
	const out = yield* decode(LogRow, rows?.rows ?? []);
	return tail === null ? out : [...out].reverse();
});
