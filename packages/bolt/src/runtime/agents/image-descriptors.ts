import { toError } from '@norbital-ai/std';
import { Effect, Option, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { ImageAsset, TaskId } from '@norbital-ai/bolt-protocol/facilities';

/** Guest/host wire token for one image. Bytes never ride this string. */
export const IMAGE_DESCRIPTOR_SCHEME = 'norbital-image:v1:';
const FILE_DESCRIPTOR_SCHEME = 'norbital-file:v1:';

const keySegment = (value: string): string => {
	let binary = '';
	for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

/** Prefix every Task image key must start with. */
export const taskAssetKeyPrefix = (taskId: TaskId | string): string =>
	`agent-tasks/${keySegment(taskId)}/`;

/** Opaque Task-scoped object key. The guest names the key; the host stores and later resolves bytes. */
export const taskAssetStorageKey = (
	taskId: TaskId | string,
	documentId: string,
	fileName: string
): string => {
	const suffix = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : '';
	const extension = /^[a-z0-9]{1,12}$/i.test(suffix) ? `.${suffix.toLowerCase()}` : '';
	return `${taskAssetKeyPrefix(taskId)}${keySegment(documentId)}${extension}`;
};

const DescriptorPayload = Schema.Struct({
	key: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	mimeType: Schema.NonEmptyString,
	size: Schema.Natural,
	detail: Schema.optionalKey(Schema.Literals(['auto', 'low', 'high']))
});

const encodePromptMessage = Schema.encodeSync(Prompt.Message);
const isString = Schema.is(Schema.String);

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
	if (!isString(data)) return undefined;
	const scheme = [IMAGE_DESCRIPTOR_SCHEME, FILE_DESCRIPTOR_SCHEME].find((scheme) =>
		data.startsWith(scheme)
	);
	if (scheme === undefined) return undefined;
	const raw = data.slice(scheme.length);
	const parsed = Option.getOrUndefined(
		Schema.decodeUnknownOption(Schema.fromJsonString(DescriptorPayload))(raw)
	);
	return parsed === undefined ? undefined : ImageAsset.make(parsed);
}

/** Collects descriptor-sized assets from one canonical Effect message. */
export function attachmentAssetsFromMessage(message: Prompt.MessageEncoded): ImageAsset[] {
	if (isString(message.content)) return [];
	return message.content.flatMap((part) => {
		if (part.type !== 'file') return [];
		const asset = decodeAttachmentDescriptor(part.data);
		return asset === undefined ? [] : [asset];
	});
}

export const imageAssetsFromMessage = (message: Prompt.MessageEncoded): ImageAsset[] =>
	attachmentAssetsFromMessage(message).filter((asset) => asset.mimeType.startsWith('image/'));

/**
 * Removes file parts before the AI facility wire.
 *
 * Colony refuses binary file parts on generate; descriptors travel as `imageAssets` instead.
 */
export function stripImageFileParts(message: Prompt.MessageEncoded): Prompt.MessageEncoded {
	if (isString(message.content)) return message;
	const content = message.content.filter((part) => part.type !== 'file');
	if (content.length === message.content.length) return message;
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

/** Same encoder as `userMessageWithImages`, with the sync throw on the typed channel. */
export function encodeUserMessageWithAttachments(
	text: string,
	assets: readonly ImageAsset[]
): Effect.Effect<Prompt.UserMessageEncoded, Error> {
	return Effect.try({
		try: () => userMessageWithAttachments(text, assets),
		catch: toError
	});
}

/** Existing image-only callers use the same descriptor encoding. */
export const userMessageWithImages = userMessageWithAttachments;
export const encodeUserMessageWithImages = encodeUserMessageWithAttachments;

/** True when a command payload carries no guest-expanded image bytes. */
export function guestImageCommandHasNoBytes(payload: unknown): boolean {
	const serialized = JSON.stringify(payload);
	return !serialized.includes('base64') && !/data:image\/[a-zA-Z0-9.+-]+;base64,/.test(serialized);
}

/** Refuses a user message whose file parts are not descriptors. */
export function assertGuestImageDescriptorsOnly(message: Prompt.MessageEncoded): void {
	if (isString(message.content)) return;
	for (const part of message.content) {
		if (part.type !== 'file') continue;
		if (decodeAttachmentDescriptor(part.data) === undefined) {
			throw new Error('Guest attachment parts must be file descriptors, not bytes.');
		}
	}
}
