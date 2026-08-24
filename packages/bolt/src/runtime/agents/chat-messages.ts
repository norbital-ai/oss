import { Option, Schema } from 'effect';

const keySegment = (value: string): string => {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const extensionOf = (fileName: string): string => {
	const candidate = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : '';
	return /^[a-z0-9]{1,12}$/i.test(candidate) ? `.${candidate.toLowerCase()}` : '';
};

/** The sole object-store namespace used by chat uploads on every surface. */
export const chatDocumentStorageKey = (
	conversationId: string,
	documentId: string,
	fileName: string
): string =>
	[
		'chat-sessions',
		keySegment(conversationId),
		`${keySegment(documentId)}${extensionOf(fileName)}`
	].join('/');

/** Refuses a caller-chosen key outside the session namespace before it can overwrite another asset. */
export const isChatDocumentStorageKey = (conversationId: string, storageKey: string): boolean =>
	storageKey.startsWith(`chat-sessions/${keySegment(conversationId)}/`) &&
	!storageKey.includes('..') &&
	storageKey.split('/').length === 3;

/** The immutable descriptor persisted for a document owned by one chat session. */
export const ChatDocumentRef = Schema.Struct({
	storage_key: Schema.NonEmptyString,
	file_name: Schema.NonEmptyString,
	file_size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	mime_type: Schema.NonEmptyString
});
export interface ChatDocumentRef extends Schema.Schema.Type<typeof ChatDocumentRef> {}

export const ChatAttachment = Schema.Struct({
	provider: Schema.NonEmptyString,
	attachmentId: Schema.NonEmptyString,
	file: ChatDocumentRef
});
export interface ChatAttachment extends Schema.Schema.Type<typeof ChatAttachment> {}

/** A message entered on a first-party chat surface. */
const StoredUserMessage = Schema.Struct({
	kind: Schema.Literal('user_message'),
	text: Schema.String,
	documents: Schema.Array(ChatDocumentRef)
});

/** One transport message inside a persisted envoy burst. */
export const InboundBatchMessage = Schema.Struct({
	sender: Schema.Struct({
		id: Schema.optionalKey(Schema.NonEmptyString),
		displayName: Schema.optionalKey(Schema.NonEmptyString)
	}),
	sentAt: Schema.NonEmptyString,
	messageId: Schema.NonEmptyString,
	text: Schema.String,
	attachments: Schema.Array(ChatAttachment),
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient'])
});
export interface InboundBatchMessage extends Schema.Schema.Type<typeof InboundBatchMessage> {}

/** A complete envoy burst, stored whole so attribution survives every replay. */
export const StoredInboundBatch = Schema.Struct({
	kind: Schema.Literal('inbound_batch'),
	messages: Schema.Array(InboundBatchMessage)
});
export interface StoredInboundBatch extends Schema.Schema.Type<typeof StoredInboundBatch> {}

export const StoredChatInput = Schema.Union([StoredUserMessage, StoredInboundBatch]);
export type StoredChatInput = Schema.Schema.Type<typeof StoredChatInput>;

const decodeStoredText = Schema.decodeUnknownOption(Schema.fromJsonString(StoredChatInput));
const decodeStoredValue = Schema.decodeUnknownOption(StoredChatInput);

export const parseStoredChatInput = (content: unknown): StoredChatInput | null => {
	const decoded =
		typeof content === 'string' ? decodeStoredText(content) : decodeStoredValue(content);
	return Option.match(decoded, { onNone: () => null, onSome: (message) => message });
};

const documentLine = (document: ChatDocumentRef): string =>
	`[document ${document.file_name} · ${document.mime_type} · ${document.file_size} bytes]`;

/** The exact text a stored chat input contributes to a model prompt. */
export const chatInputForModel = (input: StoredChatInput): string => {
	if (input.kind === 'user_message') {
		return [input.text, ...input.documents.map(documentLine)]
			.filter((line) => line.length > 0)
			.join('\n');
	}
	return [
		'INBOUND BATCH',
		...input.messages.flatMap((message) => {
			const sender = message.sender.displayName ?? message.sender.id ?? 'unidentified sender';
			const address =
				message.sender.id === undefined || message.sender.id === sender
					? ''
					: ` (${message.sender.id})`;
			const header = `[${message.sentAt}] ${sender}${address} · ${message.invocation} · ${message.messageId}`;
			return [
				header,
				...(message.text.length === 0 ? [] : [message.text]),
				...message.attachments.map(
					({ provider, attachmentId, file }) =>
						`${documentLine(file)} provider=${provider} attachment=${attachmentId}`
				)
			];
		})
	].join('\n');
};

/** A concise title seed and transcript label for either stored input shape. */
export const chatInputText = (input: StoredChatInput): string =>
	input.kind === 'user_message'
		? input.text
		: input.messages
				.map(({ text }) => text.trim())
				.filter((text) => text.length > 0)
				.join(' · ');
