// The conversation rows (§4.3, §5.9 "messages are rows"): inbound history, the outbox and envoy transcripts are
// `sys_message` rows in a `sys_conversation` (one per provider chat or mail thread of an instance), the system models the
// agents area shares. The notice writer queues each connection delivery in the same captured statement.
import { uuid } from '../port.ts';
import type { Json } from '../../decl/values.ts';
import * as EffectArray from 'effect/Array';
import { Crypto, Effect, Option, Schema } from 'effect';
import { TenantDb } from '../db/tenant-db.ts';
import { Chain } from '../write/sql.ts';
import { capturePiece } from '../db/captured.ts';
import { sha256_hex } from '@norbital-ai/store';
import type { As, MessageRow } from '../agent/schema.ts';
import { lockedHead } from '../queue.ts';

/** A `sys_message` row as the piece builder writes it. */
type MessageInsert = {
	readonly conversation: string;
	readonly role: MessageRow['role'];
	readonly content: Json;
	readonly text?: string | null | undefined;
	readonly state?: MessageRow['state'] | undefined;
	readonly mode?: MessageRow['mode'] | undefined;
	readonly as?: As | null | undefined;
	readonly author?: string | null | undefined;
	readonly meta?: Json | undefined;
	readonly files?: Json | undefined;
	readonly turn?: string | null | undefined;
	readonly supersedes?: string | null | undefined;
};

/** The platform run an ingest queues for a new live message an envoy may answer (§4.4). */
export const ADMIT = 'envoys.admit';

/** Stable ids: a redelivery of the same provider message is the same row (deduplicated by `(instance, provider_id)`). */
export const stableId = (...parts: readonly string[]): string => {
	const h = sha256_hex(JSON.stringify(parts));
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
export const conversationId = (instance: string, thread: string): string =>
	stableId('conversation', instance, thread);
export const messageId = (instance: string, provider_id: string): string =>
	stableId('message', instance, provider_id);

/** List previews cut on a character boundary at 2 KiB. */
export function preview(text: string): string {
	const bytes = new TextEncoder().encode(text);
	return bytes.length <= 2048
		? text
		: new TextDecoder().decode(bytes.slice(0, 2045)).replace(/\uFFFD+$/, '') + '...';
}
/**
 * A message's files: its conversation's inputs that name it (`message`), in their order. A file is held once, by the
 * conversation (`sys_conversation.inputs`); a message row carries none.
 */
export const filesOf = (m: string): string =>
	`(SELECT coalesce(jsonb_agg(f.e - 'message' ORDER BY f.at), '[]'::jsonb) FROM sys_conversation fc, jsonb_array_elements(fc.inputs) WITH ORDINALITY AS f(e, at)
	WHERE fc.id = ${m}.conversation AND f.e->>'message' = ${m}.id)`;
const messageImage = (alias: string, files = filesOf(alias)): string =>
	`((to_jsonb(${alias}) - 'preview') || jsonb_build_object('files', ${files}))`;
export const MSG = `${messageImage('m')} AS r`;
const names = new WeakMap<Chain, number>();
export function msg(
	c: Chain,
	statement: string,
	returning?: string | ((before: string, after: string) => string),
	files?: string
): string {
	const n = names.get(c) ?? 0;
	names.set(c, n + 1);
	return capturePiece(c, `msg${n}`, 'sys_message', statement, {
		returning: returning ?? `${messageImage('m', files)} AS r`,
		image: (alias, side) => messageImage(alias, side === 'new' ? files : undefined)
	});
}
export function post(
	c: Chain,
	message: MessageInsert & { readonly addressed?: false | undefined },
	where: string = 'true'
): string {
	const text = message.text ?? null,
		files = EffectArray.isArray<typeof message.files>(message.files) ? message.files : [],
		refs = c.p(files);
	const row = msg(
		c,
		`INSERT INTO sys_message AS m (id, conversation, role, content, text, preview, state, mode, "as", author, meta, turn, supersedes, addressed)
	SELECT gen_random_uuid()::text, ${c.p(message.conversation)}, ${c.p(message.role)}, ${c.p(message.content)}::jsonb, ${c.p(text)}, ${c.p(preview(text ?? ''))},
		${c.p(message.state === undefined ? 'queued' : message.state)}, ${c.p(message.mode === undefined ? 'agent' : message.mode)}, ${c.p(message.as ?? null)}::jsonb, ${c.p(message.author ?? null)},
		${c.p(message.meta === undefined ? null : message.meta)}::jsonb, ${c.p(message.turn ?? null)}, ${c.p(message.supersedes ?? null)}, ${c.p(message.addressed ?? true)} WHERE ${where}`,
		// the row it returns carries its files already: a sibling statement's update is not visible to its RETURNING
		`${messageImage('m', `${refs}::jsonb`)} AS r`, `${refs}::jsonb`
	);
	// a posted file is one of the conversation's inputs, naming its message
	if (files.length > 0)
		capturePiece(c,
			`${row}_inputs`,
			'sys_conversation',
			`UPDATE sys_conversation SET inputs = inputs || (SELECT jsonb_agg(f || jsonb_build_object('message', (SELECT r->>'id' FROM ${row})))
			FROM jsonb_array_elements(${refs}::jsonb) f) WHERE id = ${c.p(message.conversation)} AND EXISTS (SELECT 1 FROM ${row})`
		);
	return row;
}
export function claim(c: Chain, conversation: string, turn: string): string {
	const waiting = `q.conversation = ${c.p(conversation)} AND q.state = 'queued' AND q.delivered_turn IS NULL AND q.addressed IS DISTINCT FROM false`;
	// a message joins the transcript where it is heard, the tail, oldest first: what the model already read never moves
	return msg(
		c,
		`WITH queue_head AS MATERIALIZED (${lockedHead({
			from: 'sys_message q',
			where: `${waiting} AND q."as" IS NOT DISTINCT FROM (SELECT q."as" FROM sys_message q WHERE ${waiting} ORDER BY q.seq LIMIT 1)`,
			order: 'q.seq',
			columns: 'q.id, q.seq'
		})})
	UPDATE sys_message m SET state = 'consumed', turn = ${c.p(turn)}, delivered_turn = ${c.p(turn)}, seq = heard.seq
	FROM (SELECT id, nextval(pg_get_serial_sequence('sys_message', 'seq')) AS seq FROM queue_head ORDER BY queue_head.seq) heard
	WHERE m.id = heard.id`
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
export function cancel(c: Chain, conversation: string, message: string | null, all_scheduled = false): string {
	const source = msg(
		c,
		`UPDATE sys_message m SET state = 'cancelled' WHERE conversation = ${c.p(conversation)}
	AND (state IN ('queued', 'pending') OR (state = 'scheduled' AND ${all_scheduled ? 'true' : "meta->>'at' IS NULL"}))
	${message === null ? '' : `AND id = ${c.p(message)}`}`
	);
	msg(c, `UPDATE sys_message m SET meta = meta - 'answered' WHERE id IN
		(SELECT r->'meta'->>'question' FROM ${source} WHERE r->'meta'->>'tag' = 'answer')`);
	return source;
}
export function mark(
	c: Chain,
	message: string,
	mark:
		| { readonly readBy: string }
		| { readonly about: { readonly model: string; readonly id: string } | null }
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
			: (fallback ?? (yield* uuid(crypto)));
	const to = String(message['to']);
	const db = yield* TenantDb;
	const found = yield* db.one(Schema.Struct({ thread: Schema.String }), {
		text: 'SELECT thread FROM sys_conversation WHERE id = $1 AND integration = $2',
		params: [to, instance]
	});
	return Option.match(found, { onNone: () => to, onSome: (row) => row.thread });
});
