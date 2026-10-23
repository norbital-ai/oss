// The conversation rows (§4.3, §5.9 "messages are rows"): inbound history, the outbox and envoy transcripts are
// `sys_message` rows in a `sys_conversation` (one per provider chat or mail thread of an instance), the system models the
// agents area shares. A notice on a conversation connection is delivered by the run the engine's trigger queues
// (`engine/schema/engine.ts`).
import { createHash } from 'node:crypto';
import type { Json } from '../../decl/values.ts';
import { Crypto, Effect, Option, Schema } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { Chain } from '../write/sql.ts';
import type { MessageInsert } from '../services.ts';
import type { As } from '../agent/schema.ts';

/** The platform run that sends a connection notice to each member it names (rule 47). */
export const NOTIFY = 'notifications.deliver';
/** The platform run an ingest queues for a new live message an envoy may answer (§4.4). */
export const ADMIT = 'envoys.admit';

/** Stable ids: a redelivery of the same provider message is the same row (deduplicated by `(instance, provider_id)`). */
export const stableId = (...parts: readonly string[]): string => {
	const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
export const conversationId = (instance: string, thread: string): string =>
	stableId('conversation', instance, thread);
export const messageId = (instance: string, providerId: string): string =>
	stableId('message', instance, providerId);

/** List previews cut on a character boundary at 2 KiB. */
export function preview(text: string): string {
	const bytes = new TextEncoder().encode(text);
	return bytes.length <= 2048
		? text
		: new TextDecoder().decode(bytes.slice(0, 2045)).replace(/\uFFFD+$/, '') + '...';
}
export const MSG = `(to_jsonb(m) - 'preview') AS r`;
const names = new WeakMap<Chain, number>();
export function msg(c: Chain, statement: string, returning: string = MSG): string {
	const n = names.get(c) ?? 0;
	names.set(c, n + 1);
	return c.cte(`msg${n}`, `${statement} RETURNING ${returning}`);
}
export function post(
	c: Chain,
	message: MessageInsert & { readonly addressed?: false | undefined }
): string {
	const text = message.text ?? null;
	// a posted file is one of the conversation's inputs
	if (Array.isArray(message.files) && message.files.length > 0)
		c.cte(
			`inputs${names.get(c) ?? 0}`,
			`UPDATE sys_conversation SET inputs = inputs || ${c.p(message.files)}::jsonb WHERE id = ${c.p(message.conversation)} RETURNING id`
		);
	return msg(
		c,
		`INSERT INTO sys_message AS m (id, conversation, role, content, text, preview, state, mode, "as", author, meta, files, turn, supersedes, addressed)
	VALUES (gen_random_uuid()::text, ${c.p(message.conversation)}, ${c.p(message.role)}, ${c.p(message.content)}::jsonb, ${c.p(text)}, ${c.p(preview(text ?? ''))},
		${c.p(message.state === undefined ? 'queued' : message.state)}, ${c.p(message.mode === undefined ? 'agent' : message.mode)}, ${c.p(message.as ?? null)}::jsonb, ${c.p(message.author ?? null)},
		${c.p(message.meta === undefined ? null : message.meta)}::jsonb, ${c.p(message.files === undefined ? [] : message.files)}::jsonb, ${c.p(message.turn ?? null)}, ${c.p(message.supersedes ?? null)}, ${c.p(message.addressed ?? true)})`
	);
}
export function claim(c: Chain, conversation: string, turn: string): string {
	return msg(
		c,
		`UPDATE sys_message m SET state = 'consumed', turn = ${c.p(turn)}, delivered_turn = ${c.p(turn)}
	WHERE conversation = ${c.p(conversation)} AND state = 'queued' AND delivered_turn IS NULL AND addressed IS DISTINCT FROM false
	AND "as" IS NOT DISTINCT FROM (SELECT "as" FROM sys_message WHERE conversation = ${c.p(conversation)} AND state = 'queued'
		AND delivered_turn IS NULL AND addressed IS DISTINCT FROM false ORDER BY seq LIMIT 1)`
	);
}
export function stream(
	c: Chain,
	message: string,
	text: string,
	content: Json = { text, toolCalls: [] }
): string {
	return msg(
		c,
		`UPDATE sys_message m SET state = 'streaming', text = ${c.p(text)}, preview = ${c.p(preview(text))}, content = ${c.p(content)}::jsonb WHERE id = ${c.p(message)}`
	);
}
export function settle(
	c: Chain,
	message: string,
	patch: Pick<MessageInsert, 'content' | 'text' | 'state' | 'meta'> & {
		readonly as?: As | null | undefined;
	}
): string {
	return msg(
		c,
		`UPDATE sys_message m SET content = ${c.p(patch.content)}::jsonb, text = ${c.p(patch.text ?? null)},
	preview = ${c.p(preview(patch.text ?? ''))}, state = ${c.p(patch.state === undefined ? null : patch.state)}, meta = ${c.p(patch.meta === undefined ? null : patch.meta)}::jsonb
	${patch.as === undefined ? '' : `, "as" = ${c.p(patch.as)}::jsonb`} WHERE id = ${c.p(message)}`
	);
}
export function cancel(c: Chain, conversation: string, message: string | null): string {
	return msg(
		c,
		`UPDATE sys_message m SET state = 'cancelled' WHERE conversation = ${c.p(conversation)} AND state = 'queued'
	${message === null ? '' : `AND id = ${c.p(message)}`}`
	);
}
export function deliver(
	c: Chain,
	message: string,
	delivery: {
		readonly providerId: string;
		readonly sentAt: string;
		readonly presumeAt?: string | null | undefined;
	}
): string {
	return msg(
		c,
		`UPDATE sys_message m SET status = 'sent', provider_id = ${c.p(delivery.providerId)}, sent_at = ${c.p(delivery.sentAt)}::timestamptz,
	error = NULL, presume_at = ${c.p(delivery.presumeAt ?? null)}::timestamptz,
	delivery = coalesce(delivery, '[]'::jsonb) || ${c.p([{ kind: 'sent', at: delivery.sentAt, provider: 'bolt' }])}::jsonb WHERE id = ${c.p(message)}`
	);
}
export function mark(
	c: Chain,
	message: string,
	mark:
		| { readonly readBy: string }
		| { readonly about: { readonly collection: string; readonly id: string } | null }
): string {
	return msg(
		c,
		`UPDATE sys_message m SET ${'readBy' in mark ? `read_by = ${c.p(mark.readBy)}` : `about = ${c.p(mark.about)}::jsonb`} WHERE id = ${c.p(message)}`
	);
}

/** A chat address may name its persisted conversation; email carries the provider thread. */
export const threadOf = Effect.fn('Messages.threadOf')(function* (
	instance: string,
	kind: 'chat' | 'email',
	message: { readonly [k: string]: Json },
	crypto: Crypto.Crypto,
	fallback?: string
) {
	if (kind === 'email')
		return typeof message['thread'] === 'string'
			? message['thread']
			: (fallback ??
					(yield* crypto.randomUUIDv4.pipe(
						Effect.mapError((error) =>
							BoltError.make(
								'unavailable',
								'facility',
								'Secure random UUID generation failed.',
								error
							)
						)
					)));
	const to = String(message['to']);
	const db = yield* TenantDb;
	const found = yield* db.one(Schema.Struct({ thread: Schema.String }), {
		text: 'SELECT thread FROM sys_conversation WHERE id = $1 AND integration = $2',
		params: [to, instance]
	});
	return Option.match(found, { onNone: () => to, onSome: (row) => row.thread });
});
