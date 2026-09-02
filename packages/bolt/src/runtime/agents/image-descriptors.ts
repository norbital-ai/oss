import { toError } from '@norbital-ai/std';
import { Effect, Option, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { ImageAsset, TaskId } from '@norbital-ai/bolt-protocol/facilities';

/** Guest/host wire token for one image. Bytes never ride this string. */
export const IMAGE_DESCRIPTOR_SCHEME = 'norbital-image:v1:';

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

/** Encodes one ImageAsset as a file-part data string. Never base64 or a data URL. */
export function encodeImageDescriptorData(asset: ImageAsset): string {
	return `${IMAGE_DESCRIPTOR_SCHEME}${JSON.stringify({
		key: asset.key,
		name: asset.name,
		mimeType: asset.mimeType,
		size: asset.size,
		...(asset.detail === undefined ? {} : { detail: asset.detail })
	})}`;
}

/** Reads one descriptor from a file-part data value. Bytes and data URLs are refused. */
export function decodeImageDescriptorData(data: unknown): ImageAsset | undefined {
	if (typeof data !== 'string' || !data.startsWith(IMAGE_DESCRIPTOR_SCHEME)) return undefined;
	const raw = data.slice(IMAGE_DESCRIPTOR_SCHEME.length);
	const parsed = Option.getOrUndefined(
		Schema.decodeUnknownOption(Schema.fromJsonString(DescriptorPayload))(raw)
	);
	return parsed === undefined ? undefined : ImageAsset.make(parsed);
}

/** Collects descriptor-sized assets from one canonical Effect message. */
export function imageAssetsFromMessage(message: Prompt.MessageEncoded): ImageAsset[] {
	if (typeof message.content === 'string') return [];
	return message.content.flatMap((part) => {
		if (part.type !== 'file') return [];
		const asset = decodeImageDescriptorData(part.data);
		return asset === undefined ? [] : [asset];
	});
}

/**
 * Removes file parts before the AI facility wire.
 *
 * Colony refuses binary file parts on generate; descriptors travel as `imageAssets` instead.
 */
export function stripImageFileParts(message: Prompt.MessageEncoded): Prompt.MessageEncoded {
	if (typeof message.content === 'string') return message;
	const content = message.content.filter((part) => part.type !== 'file');
	if (content.length === message.content.length) return message;
	const onlyText = content.length === 1 ? content[0] : undefined;
	if (onlyText?.type === 'text') return { ...message, content: onlyText.text };
	if (content.length === 0) return { ...message, content: '' };
	return { ...message, content };
}

/**
 * Builds one user message: text plus descriptor file parts, never image bytes.
 *
 * Prompt.Message encode requires `content` as parts. A bare string is a Type that
 * `encodeSync` refuses (`Expected array at ["content"]`) — a sync throw, not a
 * typed Effect failure.
 */
export function userMessageWithImages(
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
export function encodeUserMessageWithImages(
	text: string,
	assets: readonly ImageAsset[]
): Effect.Effect<Prompt.UserMessageEncoded, Error> {
	return Effect.try({
		try: () => userMessageWithImages(text, assets),
		catch: toError
	});
}

/** True when a command payload carries no guest-expanded image bytes. */
export function guestImageCommandHasNoBytes(payload: unknown): boolean {
	const serialized = JSON.stringify(payload);
	return !serialized.includes('base64') && !/data:image\/[a-zA-Z0-9.+-]+;base64,/.test(serialized);
}

/** Refuses a user message whose file parts are not descriptors. */
export function assertGuestImageDescriptorsOnly(message: Prompt.MessageEncoded): void {
	if (typeof message.content === 'string') return;
	for (const part of message.content) {
		if (part.type !== 'file') continue;
		if (decodeImageDescriptorData(part.data) === undefined) {
			throw new Error('Guest image parts must be file descriptors, not bytes.');
		}
	}
}
