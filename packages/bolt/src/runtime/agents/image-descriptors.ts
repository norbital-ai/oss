import { toError } from '@norbital-ai/std';
import { Effect, Option, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { ImageAsset, ConversationId } from '@norbital-ai/bolt-protocol/facilities';

/** Guest/host wire token for one image. Bytes never ride this string. */
export const IMAGE_DESCRIPTOR_SCHEME = 'norbital-image:v1:';
const FILE_DESCRIPTOR_SCHEME = 'norbital-file:v1:';

const keySegment = (value: string): string => {
	let binary = '';
	for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

/** Prefix every Task image key must start with. */
export const taskAssetKeyPrefix = (taskId: ConversationId | string): string =>
	`agent-tasks/${keySegment(taskId)}/`;

/**
 * The media types the attachment boundary carries: images, text, and the documents the host
 * extracts. Anything else is still a stored file — the agent reaches it with a script.
 */
export const ATTACHMENT_MEDIA_TYPES =
	/^(image\/[\w.+-]+|text\/[\w.+-]+|application\/(pdf|json|(?:[\w.-]+\+)?xml|vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet)))$/;

/** At most this many attachments, totaling this many bytes, ride one message. */
export const MAX_IMAGE_COUNT = 8;
export const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;

/**
 * Why this conversation cannot read a descriptor, or `undefined` when it can.
 *
 * One predicate for the two sides that must agree: the reader tool refuses a descriptor the model
 * may not use, and the turn re-checks whatever it is about to hand the provider. The key prefix is
 * also what keeps one conversation out of another's stored objects.
 */
export const conversationAttachmentError = (
	conversationId: ConversationId | string,
	asset: ImageAsset
): string | undefined => {
	if (
		!asset.key.startsWith(taskAssetKeyPrefix(conversationId)) ||
		asset.key.includes('..') ||
		asset.key.split('/').length !== 3
	)
		return `${asset.name} is not an object stored for this conversation.`;
	if (!ATTACHMENT_MEDIA_TYPES.test(asset.mimeType))
		return `${asset.name} is ${asset.mimeType}, which the attachment reader does not carry.`;
	if (asset.size <= 0) return `${asset.name} declares no bytes.`;
	return undefined;
};

/** Opaque Task-scoped object key. The guest names the key; the host stores and later resolves bytes. */
export const conversationAssetStorageKey = (
	taskId: ConversationId | string,
	documentId: string,
	fileName: string
): string => {
	const suffix = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : '';
	const extension = /^[a-z0-9]{1,12}$/i.test(suffix) ? `.${suffix.toLowerCase()}` : '';
	return `${taskAssetKeyPrefix(taskId)}${keySegment(documentId)}${extension}`;
};

const encodePromptMessage = Schema.encodeSync(Prompt.Message);

/** Encodes one ImageAsset as a file-part data string. Never base64 or a data URL. */
function encodeImageDescriptorData(asset: ImageAsset): string {
	return `${asset.mimeType.startsWith('image/') ? IMAGE_DESCRIPTOR_SCHEME : FILE_DESCRIPTOR_SCHEME}${JSON.stringify(
		{
			key: asset.key,
			name: asset.name,
			mimeType: asset.mimeType,
			size: asset.size,
			...(asset.detail === undefined ? {} : { detail: asset.detail })
		}
	)}`;
}

/** Reads one descriptor from a file-part data value. Bytes and data URLs are refused. */
export function decodeAttachmentDescriptor(data: unknown): ImageAsset | undefined {
	if (typeof data !== 'string') return undefined;
	const scheme = [IMAGE_DESCRIPTOR_SCHEME, FILE_DESCRIPTOR_SCHEME].find((scheme) =>
		data.startsWith(scheme)
	);
	if (scheme === undefined) return undefined;
	const raw = data.slice(scheme.length);
	return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(ImageAsset))(raw));
}

/** Collects descriptor-sized assets from one canonical Effect message. */
export function attachmentAssetsFromMessage(message: Prompt.MessageEncoded): ImageAsset[] {
	if (typeof message.content === 'string') return [];
	return message.content.flatMap((part) => {
		if (part.type !== 'file') return [];
		const asset = decodeAttachmentDescriptor(part.data);
		return asset === undefined ? [] : [asset];
	});
}

/**
 * Replaces file parts with the descriptor line the model reads, before the AI facility wire.
 *
 * Colony refuses file parts on generate, and nothing attaches on a message's behalf: a descriptor
 * becomes text — name, type, size and key — and `read_attachment` is what turns a stored object into an
 * image or a document's text for the step that needs it. Bytes never reach the prompt this way.
 */
export function renderAttachmentDescriptors(message: Prompt.MessageEncoded): Prompt.MessageEncoded {
	if (typeof message.content === 'string') return message;
	if (!message.content.some((part) => part.type === 'file')) return message;
	const content = message.content.flatMap((part): Array<Prompt.PartEncoded> => {
		if (part.type !== 'file') return [part];
		const asset = decodeAttachmentDescriptor(part.data);
		return asset === undefined
			? []
			: [
					{
						type: 'text',
						text: `[attachment ${asset.name} · ${asset.mimeType} · ${asset.size} bytes] key=${asset.key}`
					} satisfies Prompt.TextPartEncoded
				];
	});
	switch (message.role) {
		case 'system':
		case 'user':
		case 'assistant': {
			const onlyText = content.length === 1 ? content[0] : undefined;
			if (onlyText?.type === 'text') return { ...message, content: onlyText.text };
			if (content.length === 0) return { ...message, content: '' };
			return { ...message, content } as Prompt.MessageEncoded;
		}
		case 'tool':
			return {
				...message,
				content: content.filter(
					(part): part is Prompt.ToolMessagePartEncoded =>
						part.type === 'tool-result' || part.type === 'tool-approval-response'
				)
			};
		default: {
			const _exhaustive: never = message;
			return _exhaustive;
		}
	}
}

/**
 * Builds one user message: text plus descriptor file parts, never image bytes.
 *
 * Prompt.Message encode requires `content` as parts. A bare string is a Type that
 * `encodeSync` refuses (`Expected array at ["content"]`) — a sync throw, not a
 * typed Effect failure.
 */
export function userMessageWithAttachments(
	text: string,
	assets: readonly ImageAsset[]
): Prompt.UserMessageEncoded {
	return encodePromptMessage(
		Prompt.userMessage({
			content: [
				Prompt.textPart({ text }),
				...assets.map((asset) =>
					Prompt.filePart({
						mediaType: asset.mimeType,
						fileName: asset.name,
						data: encodeImageDescriptorData(asset)
					})
				)
			]
		})
	) as Prompt.UserMessageEncoded;
}

/** Same encoder as `userMessageWithAttachments`, with the sync throw on the typed channel. */
export function encodeUserMessageWithAttachments(
	text: string,
	assets: readonly ImageAsset[]
): Effect.Effect<Prompt.UserMessageEncoded, Error> {
	return Effect.try({
		try: () => userMessageWithAttachments(text, assets),
		catch: toError
	});
}
