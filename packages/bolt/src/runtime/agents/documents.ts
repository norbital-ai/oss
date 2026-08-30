// repository-health:allow SEM_PARALLEL -- documents consumes chat-messages' storage-key validator,
// so the pair is linked, not parallel.
import { Context, Effect, Layer, Option, Schema } from 'effect';
import {
	ChatDocumentRef,
	EffectId,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import { eq } from 'drizzle-orm';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { Files } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { composer, executeBuilt } from '#lib/runtime/persistence.js';
import { isChatDocumentStorageKey } from './chat-messages.js';

const { chat_session: chatSession } = SYSTEM_MODEL_TABLES;

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

const FileItems = Schema.Struct({ files: Schema.optionalKey(Schema.Array(ChatDocumentRef)) });
const decodeFileItems = Schema.decodeUnknownOption(FileItems);

/**
 * Media attached to one conversation.
 *
 * The session's `files` attribute is the whole record — the bytes live in the object store under
 * the key the ref names. There is no side table and no bind step: an upload is one append to the
 * attribute, a reader asks the session itself what its sources are, and the agent's media tool
 * loads a ref's bytes on demand.
 */
export type Interface = Readonly<{
	/** Appends one file ref to the session's media attribute. Idempotent by storage key. */
	readonly attach: (
		effectId: EffectIdType,
		conversationId: string,
		file: ChatDocumentRef
	) => Effect.Effect<void, ChatDocumentError | Database.FacilityError>;
	/** Stores one file's bytes and attaches its ref — the inbound-attachment path. */
	readonly write: (
		effectId: EffectIdType,
		conversationId: string,
		file: ChatDocumentRef,
		bytes: Uint8Array
	) => Effect.Effect<void, ChatDocumentError | Database.FacilityError>;
	/** One session file's descriptor and bytes, resolved by the ref the attribute carries. */
	readonly media: (
		effectId: EffectIdType,
		conversationId: string,
		storageKey: string
	) => Effect.Effect<
		Readonly<{ readonly file: ChatDocumentRef; readonly bytes: Uint8Array }>,
		ChatDocumentError | Database.FacilityError
	>;
	/** Removes one file: attribute entry and object-store bytes together. */
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

		const attachmentsOf = (effectId: EffectIdType, conversationId: string) =>
			executeBuilt(
				effectId,
				database,
				composer
					.select({ files: chatSession.files })
					.from(chatSession)
					.where(eq(chatSession.conversation_id, conversationId))
					.limit(1)
			);

		const owned = (
			effectId: EffectIdType,
			conversationId: string,
			storageKey: string
		): Effect.Effect<ChatDocumentRef, ChatDocumentError | Database.FacilityError> =>
			Effect.gen(function* () {
				if (!isChatDocumentStorageKey(conversationId, storageKey)) {
					return yield* new ChatDocumentError({
						conversationId,
						message: 'The document key is outside this chat session namespace.'
					});
				}
				const rows = yield* attachmentsOf(EffectId.make(`${effectId}:files`), conversationId);
				const decoded = decodeFileItems(rows.rows[0]);
				const found =
					decoded._tag === 'Some'
						? decoded.value.files?.find((entry) => entry.storage_key === storageKey)
						: undefined;
				if (found === undefined) {
					return yield* new ChatDocumentError({
						conversationId,
						message: 'The document is not owned by this chat session.'
					});
				}
				return found;
			});

		const attach = Effect.fn('ChatDocuments.attach')(function* (effectId, conversationId, file) {
			if (!isChatDocumentStorageKey(conversationId, file.storage_key)) {
				return yield* new ChatDocumentError({
					conversationId,
					message: 'The file key is outside this chat session namespace.'
				});
			}
			const rows = yield* attachmentsOf(EffectId.make(`${effectId}:read`), conversationId);
			const decoded = decodeFileItems(rows.rows[0]);
			const current = decoded._tag === 'Some' ? (decoded.value.files ?? []) : [];
			const existing = current.find((entry) => entry.storage_key === file.storage_key);
			if (existing !== undefined) {
				if (
					existing.file_name !== file.file_name ||
					existing.file_size !== file.file_size ||
					existing.mime_type !== file.mime_type
				) {
					return yield* new ChatDocumentError({
						conversationId,
						message: 'The file key is already attached to different file metadata.'
					});
				}
				return;
			}
			yield* executeBuilt(
				effectId,
				database,
				composer
					.update(chatSession)
					.set({ files: [...current, file] })
					.where(eq(chatSession.conversation_id, conversationId))
			);
		});

		return Service.of({
			attach,
			write: Effect.fn('ChatDocuments.write')(function* (effectId, conversationId, file, bytes) {
				if (bytes.byteLength !== file.file_size) {
					return yield* new ChatDocumentError({
						conversationId,
						message: 'The document bytes do not match the declared size.'
					});
				}
				const rows = yield* attachmentsOf(EffectId.make(`${effectId}:before`), conversationId);
				const decoded = decodeFileItems(rows.rows[0]);
				const before = decoded._tag === 'Some' ? (decoded.value.files ?? []) : [];
				yield* attach(EffectId.make(`${effectId}:attach`), conversationId, file);
				yield* files
					.execute(EffectId.make(`${effectId}:store`), {
						_tag: 'Write',
						key: file.storage_key,
						bytes
					})
					.pipe(
						Effect.onError(() =>
							// The attribute and the bytes must fail or succeed together: an entry with
							// no bytes is a ghost, so a failed write restores the attribute and removes
							// any bytes the store may have accepted after all.
							Effect.all([
								executeBuilt(
									EffectId.make(`${effectId}:rollback-binding`),
									database,
									composer
										.update(chatSession)
										.set({ files: before })
										.where(eq(chatSession.conversation_id, conversationId))
								),
								files.execute(EffectId.make(`${effectId}:rollback-bytes`), {
									_tag: 'Delete',
									key: file.storage_key
								})
							]).pipe(Effect.ignore)
						)
					);
			}),
			media: Effect.fn('ChatDocuments.media')(function* (effectId, conversationId, storageKey) {
				const file = yield* owned(effectId, conversationId, storageKey);
				const response = yield* files
					.execute(EffectId.make(`${effectId}:read`), { _tag: 'Read', key: storageKey })
					.pipe(
						Effect.mapError(
							() =>
								new ChatDocumentError({
									conversationId,
									message: 'The document bytes could not be read.'
								})
						)
					);
				if (response.bytes === undefined) {
					return yield* new ChatDocumentError({
						conversationId,
						message: 'The document bytes could not be read.'
					});
				}
				return { file, bytes: response.bytes };
			}),
			remove: Effect.fn('ChatDocuments.remove')(function* (effectId, conversationId, storageKey) {
				const found = yield* owned(effectId, conversationId, storageKey).pipe(Effect.option);
				if (Option.isSome(found)) {
					const rows = yield* attachmentsOf(EffectId.make(`${effectId}:read`), conversationId);
					const decoded = decodeFileItems(rows.rows[0]);
					const remaining =
						decoded._tag === 'Some'
							? (decoded.value.files ?? []).filter((entry) => entry.storage_key !== storageKey)
							: [];
					yield* executeBuilt(
						effectId,
						database,
						composer
							.update(chatSession)
							.set({ files: remaining })
							.where(eq(chatSession.conversation_id, conversationId))
					);
						}
				yield* files
					.execute(EffectId.make(`${effectId}:bytes`), { _tag: 'Delete', key: storageKey })
					.pipe(Effect.ignore);
			})
		});
	})
);
