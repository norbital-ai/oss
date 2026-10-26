// The caller's approval inbox and addressed notifications.
import { Effect, Schema } from 'effect';
import type { Authority } from '../../engine/contracts.ts';
import type { TenantDbShape } from '../../engine/db/tenant-db.ts';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { NoticeRow } from '../../protocol/schema.ts';
import { inboxRequests, openRequests, type InboxRequest } from '../../engine/approvals/inbox.ts';
export type { InboxRequest } from '../../engine/approvals/inbox.ts';

const q = (text: string, ...params: Json[]) => ({ text, params });

export type Inbox = {
	readonly requests: readonly InboxRequest[];
	readonly notices: readonly NoticeRow[];
	readonly unread: number;
};
const INBOX_LIMIT = 200;
const Rows = Schema.Struct({
	notices: Schema.Array(NoticeRow),
	count: Schema.Array(Schema.Struct({ unread: Schema.Number }))
});

export const inbox = Effect.fn('shell.inbox')(function* (db: TenantDbShape, auth: Authority) {
	const a = auth.actor;
	if (a.kind !== 'member' || a.external) return { requests: [], notices: [], unread: 0 };
	const [open, notes, count] = yield* db.read([
		openRequests,
		// L-BOLT-354: an inbox notice is one row per member, fanned out when it was written; the member reads their own
		q(
			`SELECT id, title, body, link, at::text AS at, read_at IS NOT NULL AS read FROM sys_notification WHERE member = $1
			ORDER BY at DESC LIMIT ${INBOX_LIMIT}`,
			a.id
		),
		q(
			'SELECT count(*)::int AS unread FROM sys_notification WHERE member = $1 AND read_at IS NULL',
			a.id
		)
	]);
	const rows = yield* Schema.decodeUnknownEffect(Rows)({
		notices: notes?.rows ?? [],
		count: count?.rows ?? []
	}).pipe(Effect.mapError((e) => BoltError.make('internal', 'decode', String(e))));
	return {
		requests: inboxRequests(open?.rows ?? [], auth),
		unread: rows.count[0]?.unread ?? 0,
		notices: rows.notices
	};
});
