import { Crypto, Effect, Schema } from 'effect';
// A message already built (`ctx.send`, an envoy's notice, a connection notice): a queued `message` row in its
// conversation on one instance, delivered by `integrations.deliver` (engine/integrations/outbound.ts). Record-bound
// outbound is the integrations area's.
import type { Json } from '../../decl/values.ts';
import type { EngineManifest } from '../manifest.ts';
import { TenantDb as TenantDbTag, type TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { GATED, type Chain } from '../write/sql.ts';
import { sendInputSchema, deliverRun, EPOCH, QUEUED } from '../integrations/outbound.ts';
import { conversationOf, definitionOf } from '../integrations/instances.ts';
import { conversationId, preview, threadOf, msg as messagePiece } from './store.ts';
import type { RowData } from '../contracts.ts';
const sql = (text: string, ...params: Json[]) => ({ text, params });
/** A message already built: one queued row in its conversation on `instance`. */
type Send = {
	id: string;
	instance: string;
	thread: string;
	message: RowData;
	kind?: 'dm' | 'group';
	/** The sync outbox key whose acknowledgement releases this send. */
	syncWrite?: string;
};
export function sendPiece(c: Chain, s: Send, now: string, gated = false): string {
	const conv = conversationId(s.instance, s.thread);
	const text =
		typeof s.message['text'] === 'string'
			? s.message['text']
			: typeof s.message['subject'] === 'string'
				? s.message['subject']
				: '';
	c.cte(
		'sconv',
		`INSERT INTO sys_conversation (id, integration, thread, kind) SELECT ${c.p(conv)}, ${c.p(s.instance)}, ${c.p(s.thread)}, ${c.p(s.kind ?? 'dm')}
		${gated ? `WHERE ${GATED}` : ''} ON CONFLICT (id) DO NOTHING RETURNING id`
	);
	const sent = messagePiece(
		c,
		`INSERT INTO sys_message (id, conversation, integration, direction, status, meta, message, thread, text, preview, epoch, sent_at,
		next_attempt_at, created_at, delivery)
		SELECT ${c.p(s.id)}, ${c.p(conv)}, ${c.p(s.instance)}, 'outbound', 'queued', ${c.p(s.syncWrite === undefined ? null : { sync_write: s.syncWrite })}::jsonb, ${c.p(s.message)}::jsonb, ${c.p(typeof s.message['thread'] === 'string' ? s.message['thread'] : null)},
			${c.p(text)}, ${c.p(preview(text))}, ${EPOCH}, ${c.p(now)}::timestamptz, ${c.p(now)}::timestamptz, ${c.p(now)}::timestamptz, ${QUEUED(c, now)}
		${gated ? `WHERE ${GATED}` : ''} ON CONFLICT (id) DO NOTHING`,
		'id'
	);
	if (s.syncWrite === undefined) deliverRun(c, sent, now);
	return sent;
}
/**
 * `ctx.send(to, message)` checked and placed (§2.6): `to` is a connection slot or an instance id of a conversation
 * definition; a personal (owner) instance never sends. What `sendPiece` takes, or why the message cannot go.
 */
export const prepareSend = Effect.fn('Agents.prepareSend')(function* (
	m: EngineManifest,
	db: TenantDb,
	to: string,
	message: Json,
	crypto: Crypto.Crypto
) {
	const [res] = yield* db.read([
		sql('SELECT integration, owner FROM sys_integration WHERE id = $1', to)
	]);
	const inst = res!.rows[0];
	const def = inst === undefined ? undefined : definitionOf(m, String(inst['integration']));
	if (def === undefined) return { error: `no integration instance '${to}'` };
	const conv = conversationOf(def);
	if (conv === undefined)
		return { error: `'${to}' is a ${def.driver} instance; it sends no messages` };
	if (inst!['owner'] !== null)
		return { error: `'${to}' imports personal activity and cannot send` };
	const checked = yield* Schema.decodeUnknownEffect(sendInputSchema(conv.kind))(message).pipe(
		Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error))
	);
	return {
		instance: to,
		thread: yield* threadOf(to, conv.kind, checked, crypto).pipe(
			Effect.provideService(TenantDbTag, db)
		),
		message: checked
	};
});
