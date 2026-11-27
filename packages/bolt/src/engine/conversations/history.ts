// Shared newest-first raw conversation message & delivery timeline read for an integration instance.
import { Effect, Schema } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { InstanceMessage } from '../../protocol/schema.ts';
import { sql } from '../db/sql.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { filesOf } from './store.ts';

/**
 * Every inbound and outbound `sys_message` on an integration instance, newest first, a page of 100 before `seq`.
 * Callers enforce instance authorization (admin or personal owner) before invoking.
 */
export const readInstanceMessages = Effect.fn('Conversations.readInstanceMessages')(function* (
	db: TenantDbShape,
	instance: string,
	before?: string
) {
	const [known, rows] = yield* db.read([
		sql('SELECT 1 FROM sys_integration WHERE id = $1', instance),
		sql(
			`SELECT m.id, m.seq::text AS seq, m.direction, coalesce(m.sent_at, m.created_at)::text AS at, c.thread, c.kind, c.title,
			m.sender, m.sender_name, m.text, jsonb_array_length(${filesOf('m')}) AS files, m.status, m.error,
			CASE WHEN m.direction = 'outbound' AND jsonb_typeof(m.delivery) = 'array' THEN m.delivery ELSE '[]'::jsonb END AS delivery
		FROM sys_message m LEFT JOIN sys_conversation c ON c.id = m.conversation
		WHERE m.integration = $1 AND m.direction IN ('inbound', 'outbound') AND ($2::bigint IS NULL OR m.seq < $2::bigint)
		ORDER BY m.seq DESC LIMIT 100`,
			instance,
			before !== undefined && /^\d{1,18}$/.test(before) ? before : null
		)
	]);
	if ((known?.rows.length ?? 0) === 0)
		return yield* Effect.fail(
			BoltError.make('not_found', 'decode', `No integration instance '${instance}'.`)
		);
	return yield* Schema.decodeUnknownEffect(Schema.Array(InstanceMessage))(rows?.rows ?? []).pipe(
		Effect.mapError((e) => BoltError.make('internal', 'decode', String(e)))
	);
});
