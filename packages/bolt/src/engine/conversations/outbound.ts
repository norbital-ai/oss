import { Crypto, Effect, Option, Schema } from 'effect';
// A message already built (`ctx.send`, an envoy's notice, a connection notice): a queued `message` row in its
// conversation on one instance, delivered by `integrations.deliver` (engine/integrations/outbound.ts). Record-bound
// outbound is the integrations area's.
import type { Json } from '../../decl/values.ts';
import type { EngineManifest } from '../manifest.ts';
import { TenantDb as TenantDbTag, type TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { capturePiece } from '../db/captured.ts';
import { GATED, type Chain } from '../write/sql.ts';
import { send_input_schema, deliverRun, EPOCH, QUEUED } from '../integrations/outbound.ts';
import { conversationOf, definitionOf } from '../integrations/instances.ts';
import { conversationId, preview, threadOf, msg as messagePiece } from './store.ts';
import type { RowData } from '../contracts.ts';
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
	capturePiece(c,
		'sconv',
		'sys_conversation',
		`INSERT INTO sys_conversation (id, integration, thread, kind, envoy) SELECT ${c.p(conv)}, ${c.p(s.instance)}, ${c.p(s.thread)}, ${c.p(s.kind ?? 'dm')},
		(SELECT i.envoy FROM sys_integration i WHERE i.id = ${c.p(s.instance)} AND i.owner IS NULL)
		${gated ? `WHERE ${GATED}` : ''} ON CONFLICT (id) DO NOTHING`
	);
	const sent = messagePiece(
		c,
		`INSERT INTO sys_message (id, conversation, integration, direction, status, meta, message, about, thread, text, preview, epoch,
		next_attempt_at, created_at, delivery)
		SELECT ${c.p(s.id)}, ${c.p(conv)}, ${c.p(s.instance)}, 'outbound', 'queued', ${c.p(s.syncWrite === undefined ? null : { sync_write: s.syncWrite })}::jsonb, ${c.p(s.message)}::jsonb, ${c.p(s.message['about'] ?? null)}::jsonb, ${c.p(typeof s.message['thread'] === 'string' ? s.message['thread'] : null)},
			${c.p(text)}, ${c.p(preview(text))}, ${EPOCH}, ${c.p(now)}::timestamptz, ${c.p(now)}::timestamptz, ${QUEUED(c, now)}
		${gated ? `WHERE ${GATED}` : ''} ON CONFLICT (id) DO NOTHING`,
		'id'
	);
	if (s.syncWrite === undefined) deliverRun(c, sent, now);
	return sent;
}
/**
 * `ctx.send(to, message)` checked and placed: `to` is a persisted instance id of a conversation
 * definition; a personal (owner) instance never sends. What `sendPiece` takes, or why the message cannot go.
 */
export const prepareSend = Effect.fn('Agents.prepareSend')(function* (
	m: EngineManifest,
	db: TenantDb,
	to: string,
	message: Json,
	crypto: Crypto.Crypto
) {
	const found = yield* db.one(Schema.Struct({ integration: Schema.String, owner: Schema.NullOr(Schema.String) }), {
		text: 'SELECT integration,owner FROM sys_integration WHERE id=$1', params: [to]
	});
	if (Option.isNone(found)) return { error: `no integration instance '${to}'` };
	const inst = found.value;
	const def = definitionOf(m, inst.integration);
	if (def === undefined) return { error: `no integration instance '${to}'` };
	const conv = conversationOf(def);
	if (conv === undefined)
		return { error: `'${to}' is a ${def.driver} instance; it sends no messages` };
	if (inst.owner !== null)
		return { error: `'${to}' imports personal activity and cannot send` };
	const checked = yield* Schema.decodeUnknownEffect(send_input_schema(conv.kind))(message).pipe(
		Effect.mapError((error) => BoltError.make('invalid_input', 'decode', error.message, error))
	);
	return {
		instance: to,
		thread: yield* threadOf(to, conv.kind, checked, crypto).pipe(
			Effect.provideService(TenantDbTag, db)
		),
		message: checked
	};
});
