// The caller's approval inbox and addressed notifications.
import { sql } from '../../engine/db/sql.ts';
import { Effect, Schema } from 'effect';
import type { Authority } from '../../engine/contracts.ts';
import type { TenantDbShape } from '../../engine/db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { NoticeRow } from '../../protocol/schema.ts';
import { inboxRequests, inboxSql, type InboxRequest } from '../../engine/approvals/inbox.ts';
export type { InboxRequest } from '../../engine/approvals/inbox.ts';

const INBOX_LIMIT = 200;
const Rows = Schema.Struct({
	notices: Schema.Array(NoticeRow),
	count: Schema.Array(Schema.Struct({ unread: Schema.Number }))
});

/** The inbox's reads: a caller with reads of its own sends them in the same trip, and answers with `inboxOf`. */
export const inboxReads = (auth: Authority, member: string) => [
	inboxSql(auth),
	// an inbox notice is one row per member, fanned out when it was written; the member reads their own
	sql(
		`SELECT id, title, body, link, at::text AS at, read_at IS NOT NULL AS read FROM sys_notification WHERE member = $1
		ORDER BY at DESC LIMIT ${INBOX_LIMIT}`,
		member
	),
	sql(
		'SELECT count(*)::int AS unread FROM sys_notification WHERE member = $1 AND read_at IS NULL',
		member
	)
];
/** The inbox from what `inboxReads` answered, in their order. */
export const inboxOf = (
	auth: Authority,
	[open, notes, count]: Effect.Success<ReturnType<TenantDbShape['read']>>
) =>
	Schema.decodeUnknownEffect(Rows)({
		notices: notes?.rows ?? [],
		count: count?.rows ?? []
	}).pipe(
		Effect.mapError((e) => BoltError.make('internal', 'decode', String(e))),
		Effect.map((rows) => ({
			requests: inboxRequests(open?.rows ?? [], auth),
			unread: rows.count[0]?.unread ?? 0,
			notices: rows.notices
		}))
	);

export const inbox = Effect.fn('shell.inbox')(function* (db: TenantDbShape, auth: Authority) {
	const a = auth.actor;
	if (a.kind !== 'member' || a.external) return { requests: [], notices: [], unread: 0 };
	return yield* inboxOf(auth, yield* db.read(inboxReads(auth, a.id)));
});
