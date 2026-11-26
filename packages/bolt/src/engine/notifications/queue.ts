import { capturePiece } from '../db/captured.ts';
import { enqueue } from '../runs/queue.ts';
import type { Chain } from '../write/sql.ts';

export const NOTICE_DELIVER = 'notifications.deliver';
export const NOTICE_PUSH = 'bolt.push';
export const NOTICE_MAIL = 'bolt.mail';

/** A notice and the delivery jobs for its actual inserted rows share one captured statement. */
export function noticePiece(c: Chain, name: string, statement: string): string {
	const inserted = capturePiece(c, name, 'sys_notification', statement, {
		returning: 'id, member, to_jsonb(sys_notification) AS image'
	});
	for (const [automation, where] of Object.entries({
		[NOTICE_DELIVER]: "coalesce(n.image->'recipient'->>'channel', 'inbox') <> 'inbox' AND n.member IS NULL",
		[NOTICE_PUSH]: "coalesce(n.image->'recipient'->>'channel', 'inbox') = 'inbox' AND EXISTS (SELECT 1 FROM bolt_push_subscriptions)",
		[NOTICE_MAIL]:
			"coalesce(n.image->'recipient'->>'channel', 'inbox') = 'inbox' AND (n.image->'recipient'->>'email')::boolean IS TRUE AND n.member IS NOT NULL AND EXISTS (SELECT 1 FROM sys_user u WHERE u.id = n.member AND u.active AND u.email IS NOT NULL AND u.email <> '' AND lower(split_part(u.email, '@', 2)) !~ '(^|\\.)(invalid|example|test|localhost|example\\.(com|net|org))$')"
	}))
		enqueue(c, {
			select: `SELECT ${c.p(automation)}::text AS automation, jsonb_build_object('ids', jsonb_agg(n.id)) AS input,
			min((n.image->>'at')::timestamptz) AS due_at, 'schedule'::text AS cause, 0 AS depth
			FROM ${inserted} n WHERE ${where} HAVING count(*) > 0`
		});
	return inserted;
}
