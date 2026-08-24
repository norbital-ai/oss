import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { and, eq } from 'drizzle-orm';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { Files } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as SyncWake from '#lib/runtime/sync/wake.js';
import { composer, executeBuilt } from '#lib/runtime/persistence.js';
import { ChatDocumentRef } from './chat-messages.js';

const { chat_session: chatSession, chat_document: chatDocument } = SYSTEM_MODEL_TABLES;

export class ChatDocumentError extends Schema.TaggedError<ChatDocumentError>()(
	'Bolt.ChatDocument.Error',
	{
		conversationId: Schema.NonEmptyString,
		message: Schema.NonEmptyString
	}
) {
	readonly category = 'chat-document' as const;
	readonly retryable = false;
}

type DocumentProvenance = Readonly<{
	readonly source: 'web' | 'envoy' | 'agent';
	readonly messageId?: string;
	readonly provider?: string;
	readonly providerAttachmentId?: string;
	readonly senderId?: string;
}>;

const StoredDocumentRow = Schema.Struct({
	conversation_id: Schema.NonEmptyString,
	storage_key: Schema.NonEmptyString,
	file_name: Schema.NonEmptyString,
	file_size: Schema.Number,
	mime_type: Schema.NonEmptyString
});
const decodeStoredDocumentRow = Schema.decodeUnknownOption(StoredDocumentRow);
const IdRow = Schema.Struct({ id: Schema.NonEmptyString });
const decodeIdRow = Schema.decodeUnknownOption(IdRow);

export type Interface = Readonly<{
	readonly bind: (
		effectId: EffectIdType,
		conversationId: string,
		file: ChatDocumentRef,
		provenance: DocumentProvenance
	) => Effect.Effect<void, ChatDocumentError | Database.FacilityError>;
	readonly write: (
		effectId: EffectIdType,
		conversationId: string,
		file: ChatDocumentRef,
		bytes: Uint8Array,
		provenance: DocumentProvenance
	) => Effect.Effect<void, ChatDocumentError | Database.FacilityError>;
	readonly resolve: (
		effectId: EffectIdType,
		conversationId: string,
		storageKey: string
	) => Effect.Effect<ChatDocumentRef, ChatDocumentError | Database.FacilityError>;
	readonly read: (
		effectId: EffectIdType,
		conversationId: string,
		storageKey: string
	) => Effect.Effect<
		Readonly<{ readonly file: ChatDocumentRef; readonly bytes: Uint8Array }>,
		ChatDocumentError | Database.FacilityError
	>;
	readonly remove: (
		effectId: EffectIdType,
		conversationId: string,
		storageKey: string
	) => Effect.Effect<void, ChatDocumentError | Database.FacilityError>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/ChatDocuments');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;
		const files = yield* Files.Service;
		const wake = yield* SyncWake.Service;

		const requireConversation = Effect.fn('ChatDocuments.requireConversation')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ id: chatSession.id })
					.from(chatSession)
					.where(eq(chatSession.conversation_id, conversationId))
					.limit(1)
			);
			if (decodeIdRow(result.rows[0])._tag === 'None') {
				return yield* new ChatDocumentError({
					conversationId,
					message: 'The chat session does not exist.'
				});
			}
		});

		const resolve = Effect.fn('ChatDocuments.resolve')(function* (
			effectId: EffectIdType,
			conversationId: string,
			storageKey: string
		) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({
						conversation_id: chatDocument.conversation_id,
						storage_key: chatDocument.storage_key,
						file_name: chatDocument.file_name,
						file_size: chatDocument.file_size,
						mime_type: chatDocument.mime_type
					})
					.from(chatDocument)
					.where(
						and(
							eq(chatDocument.conversation_id, conversationId),
							eq(chatDocument.storage_key, storageKey)
						)
					)
					.limit(1)
			);
			const decoded = decodeStoredDocumentRow(result.rows[0]);
			if (decoded._tag === 'None') {
				return yield* new ChatDocumentError({
					conversationId,
					message: 'The document is not owned by this chat session.'
				});
			}
			const { conversation_id: _conversationId, ...file } = decoded.value;
			return file;
		});

		const bind = Effect.fn('ChatDocuments.bind')(function* (
			effectId: EffectIdType,
			conversationId: string,
			file: ChatDocumentRef,
			provenance: DocumentProvenance
		) {
			yield* requireConversation(EffectId.make(`${effectId}:conversation`), conversationId);
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.insert(chatDocument)
					.values({
						conversation_id: conversationId,
						storage_key: file.storage_key,
						file_name: file.file_name,
						file_size: file.file_size,
						mime_type: file.mime_type,
						source: provenance.source,
						message_id: provenance.messageId ?? null,
						provider: provenance.provider ?? null,
						provider_attachment_id: provenance.providerAttachmentId ?? null,
						sender_id: provenance.senderId ?? null
					})
					.onConflictDoNothing({ target: chatDocument.storage_key })
					.returning({ id: chatDocument.id })
			);
			if (result.rows.length === 0) {
				const existing = yield* resolve(
					EffectId.make(`${effectId}:existing`),
					conversationId,
					file.storage_key
				);
				if (
					existing.file_name !== file.file_name ||
					existing.file_size !== file.file_size ||
					existing.mime_type !== file.mime_type
				) {
					return yield* new ChatDocumentError({
						conversationId,
						message: 'The document key is already bound to different file metadata.'
					});
				}
				return;
			}
			yield* wake.announce(EffectId.make(`${effectId}:sync`), ['chat_document']);
		});

		return Service.of({
			bind,
			write: Effect.fn('ChatDocuments.write')(
				function* (effectId, conversationId, file, bytes, provenance) {
					if (bytes.byteLength !== file.file_size) {
						return yield* new ChatDocumentError({
							conversationId,
							message: 'The document bytes do not match the declared size.'
						});
					}
					yield* bind(EffectId.make(`${effectId}:bind`), conversationId, file, provenance);
					yield* files
						.execute(EffectId.make(`${effectId}:store`), {
							_tag: 'Write',
							key: file.storage_key,
							bytes
						})
						.pipe(
							Effect.onError(() =>
								Effect.all([
									executeBuilt(
										EffectId.make(`${effectId}:rollback-binding`),
										database,
										composer
											.delete(chatDocument)
											.where(
												and(
													eq(chatDocument.conversation_id, conversationId),
													eq(chatDocument.storage_key, file.storage_key)
												)
											)
									),
									files.execute(EffectId.make(`${effectId}:rollback-bytes`), {
										_tag: 'Delete',
										key: file.storage_key
									})
								]).pipe(Effect.ignore)
							)
						);
				}
			),
			resolve,
			read: Effect.fn('ChatDocuments.read')(function* (effectId, conversationId, storageKey) {
				const file = yield* resolve(
					EffectId.make(`${effectId}:resolve`),
					conversationId,
					storageKey
				);
				const response = yield* files.execute(EffectId.make(`${effectId}:read`), {
					_tag: 'Read',
					key: storageKey
				});
				if (response.bytes === undefined) {
					return yield* new ChatDocumentError({
						conversationId,
						message: 'The bound document has no stored bytes.'
					});
				}
				return { file, bytes: response.bytes };
			}),
			remove: Effect.fn('ChatDocuments.remove')(function* (effectId, conversationId, storageKey) {
				yield* resolve(EffectId.make(`${effectId}:resolve`), conversationId, storageKey);
				yield* executeBuilt(
					EffectId.make(`${effectId}:unbind`),
					database,
					composer
						.delete(chatDocument)
						.where(
							and(
								eq(chatDocument.conversation_id, conversationId),
								eq(chatDocument.storage_key, storageKey)
							)
						)
				);
				yield* files.execute(EffectId.make(`${effectId}:delete`), {
					_tag: 'Delete',
					key: storageKey
				});
				yield* wake.announce(EffectId.make(`${effectId}:sync`), ['chat_document']);
			})
		});
	})
);
