import { Context, Effect, Layer, Schema } from 'effect';
import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { decodeNumber } from '@norbital-ai/std/json';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { composer, executeBuilt } from '#lib/runtime/persistence.js';

const { bolt_envoy_messages: envoyMessages } = SYSTEM_MODEL_TABLES;

/**
 * One attachment as the replica stores it: provider facts plus the durable key when bytes were
 * materialized at ingest. A descriptor without a key is media the provider could not hand over —
 * it is listed to the reader, never silently missing.
 */
export const ReplicaAttachment = Schema.Struct({
	provider: Schema.NonEmptyString,
	attachmentId: Schema.NonEmptyString,
	kind: Schema.Literals(['image', 'video', 'audio', 'document', 'sticker', 'other']),
	mimeType: Schema.NonEmptyString,
	fileName: Schema.NonEmptyString,
	size: Schema.Natural,
	key: Schema.optionalKey(Schema.NonEmptyString)
});
export interface ReplicaAttachment extends Schema.Schema.Type<typeof ReplicaAttachment> {}

export const ReplicaMessage = Schema.Struct({
	sent_at: Schema.NonEmptyString,
	sender_external_id: Schema.NullOr(Schema.String),
	sender_display_name: Schema.NullOr(Schema.String),
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	text: Schema.String,
	attachments: Schema.Array(ReplicaAttachment)
});
export interface ReplicaMessage extends Schema.Schema.Type<typeof ReplicaMessage> {}

/** Where this conversation's replica begins, so a reader never claims knowledge before it. */
export type ReplicaHorizon = Readonly<{
	floorAt: string | null;
	/** Synced rows older than the first live arrival: content from before this tenant paired. */
	prePairing: number;
}>;

export type ReadResult = Readonly<{
	messages: ReadonlyArray<ReplicaMessage>;
	/** Unread rows still waiting after this read. */
	unreadAfter: number;
	horizon: ReplicaHorizon;
}>;

/**
 * The read half of the channel replica.
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

const countOf = (value: unknown): number => {
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
						floor_at: sql<string | null>`min(${envoyMessages.sent_at})`.as('floor_at'),
						first_live_at: sql<
							string | null
						>`min(${envoyMessages.created_at}) filter (where ${envoyMessages.origin} = 'live')`.as(
							'first_live_at'
						)
					})
					.from(envoyMessages)
					.where(
						and(
							eq(envoyMessages.conversation_id, conversationId),
							eq(envoyMessages.direction, 'inbound')
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
					.from(envoyMessages)
					.where(
						and(
							eq(envoyMessages.conversation_id, conversationId),
							eq(envoyMessages.direction, 'inbound'),
							eq(envoyMessages.origin, 'sync'),
							sql`${envoyMessages.sent_at} < ${firstLiveAt}`
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
						.from(envoyMessages)
						.where(
							and(
								eq(envoyMessages.conversation_id, conversationId),
								eq(envoyMessages.direction, 'inbound'),
								eq(envoyMessages.addressed, false),
								isNull(envoyMessages.read_by)
							)
						)
				);
				return countOf(Reflect.get((rows.rows[0] as object | undefined) ?? {}, 'count'));
			}),

			read: Effect.fn('EnvoyInbox.read')(function* (effectId, conversationId, readBy, limit) {
				const readable = or(isNull(envoyMessages.read_by), eq(envoyMessages.read_by, readBy));
				const bounded = Math.max(1, Math.min(50, Math.floor(limit)));
				const rows = yield* executeBuilt(
					EffectId.make(`${effectId}:rows`),
					database,
					composer
						.select({
							id: envoyMessages.id,
							sent_at: envoyMessages.sent_at,
							sender_external_id: envoyMessages.sender_external_id,
							sender_display_name: envoyMessages.sender_display_name,
							invocation: envoyMessages.invocation,
							text: envoyMessages.text,
							attachments: envoyMessages.attachments
						})
						.from(envoyMessages)
						.where(
							and(
								eq(envoyMessages.conversation_id, conversationId),
								eq(envoyMessages.direction, 'inbound'),
								eq(envoyMessages.addressed, false),
								readable
							)
						)
						.orderBy(asc(envoyMessages.sent_at), asc(envoyMessages.id))
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
							.update(envoyMessages)
							.set({ read_by: readBy })
							.where(
								and(
									isNull(envoyMessages.read_by),
									eq(envoyMessages.conversation_id, conversationId),
									eq(envoyMessages.direction, 'inbound'),
									eq(envoyMessages.addressed, false),
									inArray(
										envoyMessages.id,
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
						.from(envoyMessages)
						.where(
							and(
								eq(envoyMessages.conversation_id, conversationId),
								eq(envoyMessages.direction, 'inbound'),
								eq(envoyMessages.addressed, false),
								isNull(envoyMessages.read_by)
							)
						)
				);
				return {
					messages: decoded.map(
						({
							sent_at,
							sender_external_id,
							sender_display_name,
							invocation,
							text,
							attachments
						}) => ({
							sent_at,
							sender_external_id,
							sender_display_name,
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
