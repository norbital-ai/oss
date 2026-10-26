// An administrator's paged view of an integration instance's messages and delivery timeline.
import { Effect, Schema } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import type { Authority } from '../../engine/contracts.ts';
import type { TenantDbShape } from '../../engine/db/tenant-db.ts';
import { filesOf } from '../../engine/conversations/store.ts';
import { requireAdmin } from '../../engine/identity/session.ts';
import type { Json } from '../../decl/values.ts';
import { InstanceMessage } from '../api-types.ts';

const q = (text: string, ...params: Json[]) => ({ text, params });

const decode = <A>(schema: Schema.Decoder<A>, rows: unknown) =>
	Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
		Effect.mapError((e) => BoltError.make('internal', 'decode', String(e)))
	);

/**
 * An instance's raw messages (§5.9 built-in reads): every inbound and outbound `sys_message` on it, newest first, a page of
 * 100 before `seq`; an administrator's, like the rest of Settings.
 */
export const instanceMessages = Effect.fn('shell.instanceMessages')(function* (
	db: TenantDbShape,
	auth: Authority,
	instance: string,
	before?: string
) {
	const refusal = requireAdmin(auth);
	if (refusal !== null) return yield* Effect.fail(refusal);
	const [known, rows] = yield* db.read([
		q('SELECT 1 FROM sys_integration WHERE id = $1', instance),
		q(
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
			BoltError.make('notFound', 'decode', `No integration instance '${instance}'.`)
		);
	return yield* decode(InstanceMessage, rows?.rows ?? []);
});
