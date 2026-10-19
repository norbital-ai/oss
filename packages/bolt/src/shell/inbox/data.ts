// The caller's approval inbox and addressed notifications.
import { Effect } from 'effect';
import type { Authority } from '../../engine/contracts.ts';
import type { TenantDbShape } from '../../engine/db/tenant-db.ts';
import type { Json } from '../../decl/values.ts';
import { inboxRequests, openRequests, type InboxRequest } from '../../engine/approvals/inbox.ts';
export type { InboxRequest } from '../../engine/approvals/inbox.ts';

const q = (text: string, ...params: Json[]) => ({ text, params });

export type Notice = {
	id: string;
	title: string;
	body: string | null;
	link: Json;
	at: string;
	read: boolean;
};
export type Inbox = { requests: InboxRequest[]; notices: Notice[]; unread: number };
const INBOX_LIMIT = 200;

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
	const requests = inboxRequests(open?.rows ?? [], auth);
	return {
		requests,
		unread: Number(count?.rows[0]?.['unread'] ?? 0),
		notices: (notes?.rows ?? []).map((n) => ({
			id: String(n['id']),
			title: String(n['title']),
			body: typeof n['body'] === 'string' ? n['body'] : null,
			link: n['link'] ?? null,
			at: String(n['at']),
			read: n['read'] === true
		}))
	};
});
