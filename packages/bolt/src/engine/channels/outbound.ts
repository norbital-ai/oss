// Record-driven outbound (rule 61, §3.3.8): a row created in an `outbound.from` collection writes its `sys_message` in
// the causing act's own statement, with the `channels.deliver` run that sends it. The message is built at delivery by
// the declared pure `message` body from the row as committed, so the write path runs no guest code; a builder that
// throws, or builds what its transport refuses, fails the delivery (visible on the row), never the write.
import type { Json } from '../../decl/values.ts';
import type { EngineManifest, TenantDb } from '../contracts.ts';
import { GATED, type Chain } from '../write/sql.ts';
import { conversationId, isObj, preview, sql, type Obj } from './store.ts';

export const DELIVER = 'channels.deliver';
/** Every transport that takes a chat message (`{ to, text, attachments? }`): the chat providers and a custom channel. */
const CHAT = new Set(['whatsapp', 'telegram', 'slack', 'discord', 'wechat', 'custom']);
type Rule = { channel: string; rule: string; from: string };
const cache = new WeakMap<EngineManifest, readonly Rule[]>();
export function outboundRules(m: EngineManifest): readonly Rule[] {
	let r = cache.get(m);
	if (r === undefined) {
		r = Object.entries(m.channels).flatMap(([channel, spec]) =>
			Object.entries(isObj(spec['outbound']) ? spec['outbound'] : {}).flatMap(([rule, o]) =>
				isObj(o) && typeof o['from'] === 'string' ? [{ channel, rule, from: o['from'] }] : []
			)
		);
		cache.set(m, r);
	}
	return r;
}
/** hook:envoys (engine/index.ts) — whether a commit's captured rows queued a delivery, for the deadlines port. */
export const queuesOutbound = (
	m: EngineManifest,
	captured: readonly { collection: string; op: string; cause: string }[]
): boolean =>
	captured.some(
		(x) =>
			x.op === 'create' &&
			x.cause === 'direct' &&
			outboundRules(m).some((r) => r.from === x.collection)
	);

/** A new row's timeline: accepted by bolt, not yet handed to the provider (§5.9). */
const QUEUED = (c: Chain, now: string) =>
	`jsonb_build_array(jsonb_build_object('kind', 'queued', 'at', ${c.p(now)}::text, 'provider', 'bolt'))`;
/** The epoch new outbound rows carry; a row of another epoch (a fork, a restore) is never sent. */
const EPOCH = `coalesce((SELECT value FROM sys_config WHERE key = 'channels.epoch'), '')`;
const deliverRun = (c: Chain, from: string, now: string) =>
	c.cte(
		`${from}_run`,
		`INSERT INTO sys_run (id, automation, input, due_at, cause, depth) SELECT gen_random_uuid()::text, '${DELIVER}', '{}'::jsonb,
		${c.p(now)}::timestamptz, 'schedule', 0 WHERE EXISTS (SELECT 1 FROM ${from}) RETURNING id`
	);

/** hook:envoys (write/commit.ts) — the act statement's outbound piece, reading the statement's own creates (`allp`). */
export function outboundPiece(m: EngineManifest, c: Chain, now: string): void {
	const rules = outboundRules(m);
	if (rules.length === 0) return;
	const rows = rules
		.map(
			(
				r
			) => `SELECT ${c.p(r.channel)}::text AS ch, ${c.p(r.rule)}::text AS rule, x.c, x.id FROM allp x
		WHERE x.c = ${c.p(r.from)} AND x.op = 'create' AND x.cause = 'direct'`
		)
		.join(' UNION ALL ');
	c.cte(
		'outbound',
		`INSERT INTO sys_message (id, channel, direction, status, record, rule, epoch, next_attempt_at, created_at, delivery)
		SELECT gen_random_uuid()::text, o.ch, 'outbound', 'queued', jsonb_build_object('collection', o.c, 'id', o.id), o.rule, ${EPOCH},
			${c.p(now)}::timestamptz, ${c.p(now)}::timestamptz, ${QUEUED(c, now)} FROM (${rows}) o RETURNING id`
	);
	deliverRun(c, 'outbound', now);
}

/** A message already built (`ctx.send`, an envoy reply, a notice): one queued row in its conversation. */
export type Send = {
	id: string;
	channel: string;
	thread: string;
	message: Obj;
	kind?: 'dm' | 'group';
};
export function sendPiece(c: Chain, s: Send, now: string, gated = false): string {
	const conv = conversationId(s.channel, s.thread);
	const text =
		typeof s.message['text'] === 'string'
			? s.message['text']
			: typeof s.message['subject'] === 'string'
				? s.message['subject']
				: '';
	c.cte(
		'sconv',
		`INSERT INTO sys_conversation (id, channel, thread, kind) SELECT ${c.p(conv)}, ${c.p(s.channel)}, ${c.p(s.thread)}, ${c.p(s.kind ?? 'dm')}
		${gated ? `WHERE ${GATED}` : ''} ON CONFLICT (id) DO NOTHING RETURNING id`
	);
	const sent = c.cte(
		'sent',
		`INSERT INTO sys_message (id, conversation, channel, direction, status, message, thread, text, preview, epoch, sent_at,
		next_attempt_at, created_at, delivery)
		SELECT ${c.p(s.id)}, ${c.p(conv)}, ${c.p(s.channel)}, 'outbound', 'queued', ${c.p(s.message)}::jsonb, ${c.p(typeof s.message['thread'] === 'string' ? s.message['thread'] : null)},
			${c.p(text)}, ${c.p(preview(text))}, ${EPOCH}, ${c.p(now)}::timestamptz, ${c.p(now)}::timestamptz, ${c.p(now)}::timestamptz, ${QUEUED(c, now)}
		${gated ? `WHERE ${GATED}` : ''} ON CONFLICT (id) DO NOTHING RETURNING id`
	);
	deliverRun(c, 'sent', now);
	return sent;
}

/**
 * A message's conversation: an email's `thread` (else `fallback`, a fresh thread), a chat's `to` (a handle, or a
 * `sys_conversation` id whose thread it names).
 */
export async function threadOf(
	m: EngineManifest,
	db: TenantDb,
	channel: string,
	message: Obj,
	fallback: string = crypto.randomUUID()
): Promise<string> {
	if (m.channels[channel]?.['transport'] === 'email')
		return typeof message['thread'] === 'string' ? message['thread'] : fallback;
	const to = String(message['to']);
	const [res] = await db.read([
		sql(`SELECT thread FROM sys_conversation WHERE id = $1 AND channel = $2`, to, channel)
	]);
	return (res!.rows[0]?.['thread'] as string | undefined) ?? to;
}
/** `ctx.send(channel, message)` checked and placed: what `sendPiece` takes, or why the message cannot go. */
export async function prepareSend(
	m: EngineManifest,
	db: TenantDb,
	channel: string,
	message: Json
): Promise<Omit<Send, 'id'> | { error: string }> {
	const spec = m.channels[channel];
	if (spec === undefined) return { error: `no channel '${channel}'` };
	if (spec['syncOnly'] === true)
		return { error: `the ${channel} channel imports personal activity and cannot send` };
	const checked = checkOutbound(String(spec['transport']), message);
	if ('error' in checked) return checked;
	return {
		channel,
		thread: await threadOf(m, db, channel, checked.message),
		message: checked.message
	};
}

/** `OutboundFor<T>` at runtime: the shape a transport takes, or the reason it does not. */
export function checkOutbound(transport: string, x: Json): { message: Obj } | { error: string } {
	if (!isObj(x)) return { error: 'the message is not an object' };
	const strings = (v: unknown) =>
		Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '');
	// a message row is persisted as it is: an attachment is a stored file's reference, never its bytes
	const inline =
		Array.isArray(x['attachments']) &&
		x['attachments'].some((a) => !isObj(a) || typeof a['id'] !== 'string' || 'base64' in a);
	if (inline)
		return {
			error:
				'an attachment is a stored file (a FileRef from ctx.files.put or bolt.upload), never inline bytes'
		};
	if (transport === 'email') {
		if (!strings(x['to'])) return { error: 'an email needs `to`, a non-empty list of addresses' };
		if (typeof x['subject'] !== 'string') return { error: 'an email needs a `subject`' };
		if (typeof x['text'] !== 'string' && typeof x['html'] !== 'string')
			return { error: 'an email needs `text` or `html`' };
		return { message: x };
	}
	if (CHAT.has(transport)) {
		if (typeof x['to'] !== 'string' || x['to'] === '')
			return { error: `a ${transport} message needs \`to\`` };
		if (typeof x['text'] !== 'string') return { error: `a ${transport} message needs \`text\`` };
		return { message: x };
	}
	return { error: `the ${transport} channel sends no messages` };
}
