import { Context, Effect, Layer, Schema } from 'effect';
import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { decodeNumber } from '@norbital-ai/std/json';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { composer, executeBuilt } from '#lib/runtime/persistence.js';

const { channel_messages: messages } = SYSTEM_MODEL_TABLES;

/**
 * One attachment as history stores it: provider facts plus the durable key when bytes were
 * materialized at ingest. A descriptor without a key is media the provider could not hand over —
 * it is listed to the reader, never silently missing.
 */
const ReplicaAttachment = Schema.Struct({
	provider: Schema.NonEmptyString,
	attachmentId: Schema.NonEmptyString,
	kind: Schema.Literals(['image', 'video', 'audio', 'document', 'sticker', 'other']),
	mimeType: Schema.NonEmptyString,
	fileName: Schema.NonEmptyString,
	size: Schema.Natural,
	key: Schema.optionalKey(Schema.NonEmptyString)
});

const ReplicaMessage = Schema.Struct({
	sent_at: Schema.NonEmptyString,
	sender_id: Schema.NullOr(Schema.String),
	sender_name: Schema.NullOr(Schema.String),
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	text: Schema.String,
	attachments: Schema.Array(ReplicaAttachment)
});
interface ReplicaMessage extends Schema.Schema.Type<typeof ReplicaMessage> {}

/** Where this conversation's replica begins, so a reader never claims knowledge before it. */
type ReplicaHorizon = Readonly<{
	floorAt: string | null;
	/** Synced rows older than the first live arrival: content from before this tenant paired. */
	prePairing: number;
}>;

type ReadResult = Readonly<{
	messages: ReadonlyArray<ReplicaMessage>;
	/** Unread rows still waiting after this read. */
	unreadAfter: number;
	horizon: ReplicaHorizon;
}>;

/**
 * The read half of a channel's history, for its envoy: the ambient messages a turn was not asked
 * about. A message its sender deleted is gone from every read.
 *
 * Separate from the Envoys service on purpose: the agent runtime needs it, and the agent runtime is
 * what the Envoys service is built on — so this module depends on the database alone and never on
 * either of them.
 */
export type Interface = Readonly<{
	readonly unread: (
		effectId: EffectId,
		conversationId: string
	) => Effect.Effect<number, Database.FacilityError>;
	readonly read: (
		effectId: EffectId,
		conversationId: string,
		/**
		 * The tool call this read belongs to. Stable across a replay of the same call, so a crash
		 * between marking and answering returns the same batch instead of losing it.
		 */
		readBy: string,
		limit: number
	) => Effect.Effect<ReadResult, Database.FacilityError>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/EnvoyInbox');

/** A `count(*)` as the driver hands it over — a JSON-safe string or a number. */
export const countOf = (value: unknown): number => {
	const decoded = decodeNumber(value as string | number);
	return Number.isFinite(decoded) ? Math.max(0, Math.floor(decoded)) : 0;
};

export const layer: Layer.Layer<Interface, never, Database.Interface> = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;

		const horizonOf = Effect.fn('EnvoyInbox.horizon')(function* (
			effectId: EffectId,
			conversationId: string
		) {
			const bounds = yield* executeBuilt(
				EffectId.make(`${effectId}:bounds`),
				database,
				composer
					.select({
						floor_at: sql<string | null>`min(${messages.sent_at})`.as('floor_at'),
						first_live_at: sql<
							string | null
						>`min(${messages.created_at}) filter (where ${messages.origin} = 'live')`.as(
							'first_live_at'
						)
					})
					.from(messages)
					.where(
						and(
							eq(messages.agent_conversation_id, conversationId),
							eq(messages.direction, 'inbound')
						)
					)
			);
			const row = bounds.rows[0];
			const floorAt = Reflect.get((row as object | undefined) ?? {}, 'floor_at');
			const firstLiveAt = Reflect.get((row as object | undefined) ?? {}, 'first_live_at');
			if (firstLiveAt == null) return { floorAt: floorAt ?? null, prePairing: 0 };
			const before = yield* executeBuilt(
				EffectId.make(`${effectId}:pre-pairing`),
				database,
				composer
					.select({ count: count() })
					.from(messages)
					.where(
						and(
							eq(messages.agent_conversation_id, conversationId),
							eq(messages.direction, 'inbound'),
							eq(messages.origin, 'sync'),
							sql`${messages.sent_at} < ${firstLiveAt}`
						)
					)
			);
			return {
				floorAt: floorAt ?? null,
				prePairing: countOf(Reflect.get((before.rows[0] as object | undefined) ?? {}, 'count'))
			};
		});

		return Service.of({
			unread: Effect.fn('EnvoyInbox.unread')(function* (effectId, conversationId) {
				const rows = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ count: count() })
						.from(messages)
						.where(
							and(
								eq(messages.agent_conversation_id, conversationId),
								eq(messages.direction, 'inbound'),
								eq(messages.addressed, false),
								isNull(messages.deleted_at),
								isNull(messages.read_by)
							)
						)
				);
				return countOf(Reflect.get((rows.rows[0] as object | undefined) ?? {}, 'count'));
			}),

			read: Effect.fn('EnvoyInbox.read')(function* (effectId, conversationId, readBy, limit) {
				const readable = or(isNull(messages.read_by), eq(messages.read_by, readBy));
				const bounded = Math.max(1, Math.min(50, Math.floor(limit)));
				const rows = yield* executeBuilt(
					EffectId.make(`${effectId}:rows`),
					database,
					composer
						.select({
							id: messages.id,
							sent_at: messages.sent_at,
							sender_id: messages.sender_id,
							sender_name: messages.sender_name,
							invocation: messages.invocation,
							text: messages.text,
							attachments: messages.attachments
						})
						.from(messages)
						.where(
							and(
								eq(messages.agent_conversation_id, conversationId),
								eq(messages.direction, 'inbound'),
								eq(messages.addressed, false),
								isNull(messages.deleted_at),
								readable
							)
						)
						.orderBy(asc(messages.sent_at), asc(messages.id))
						.limit(bounded)
				);
				const decoded = rows.rows.flatMap((row) => {
					const candidate = Schema.decodeUnknownOption(
						Schema.Struct({
							...ReplicaMessage.fields,
							id: Schema.NonEmptyString
						})
					)(row);
					return candidate._tag === 'Some' ? [candidate.value] : [];
				});
				if (decoded.length > 0)
					yield* executeBuilt(
						EffectId.make(`${effectId}:mark`),
						database,
						composer
							.update(messages)
							.set({ read_by: readBy })
							.where(
								and(
									isNull(messages.read_by),
									eq(messages.agent_conversation_id, conversationId),
									eq(messages.direction, 'inbound'),
									eq(messages.addressed, false),
								isNull(messages.deleted_at),
									inArray(
										messages.id,
										decoded.map(({ id }) => id)
									)
								)
							)
					);
				const remaining = yield* executeBuilt(
					EffectId.make(`${effectId}:remaining`),
					database,
					composer
						.select({ count: count() })
						.from(messages)
						.where(
							and(
								eq(messages.agent_conversation_id, conversationId),
								eq(messages.direction, 'inbound'),
								eq(messages.addressed, false),
								isNull(messages.deleted_at),
								isNull(messages.read_by)
							)
						)
				);
				return {
					messages: decoded.map(
						({ sent_at, sender_id, sender_name, invocation, text, attachments }) => ({
							sent_at,
							sender_id,
							sender_name,
							invocation,
							text,
							attachments
						})
					),
					unreadAfter: countOf(
						Reflect.get((remaining.rows[0] as object | undefined) ?? {}, 'count')
					),
					horizon: yield* horizonOf(EffectId.make(`${effectId}:horizon`), conversationId)
				};
			})
		});
	})
);
