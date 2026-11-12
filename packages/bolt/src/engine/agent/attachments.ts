import { Effect, Option, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Images, type Files, type Logs } from '../ports.ts';
import { image_jpeg } from '../files/image.ts';
import { row } from '../system/rows.ts';
import { MODEL_FILES } from './ai.ts';
import type { AttachmentPort } from './tools.ts';
import type { FileRef as MessageFile } from './schema.ts';
import { route } from './ingest.ts';
import { toBase64 } from '../crypto.ts';

const Ref = Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) });
const Stored = row('sys_file', ['id', 'name', 'mime', 'size', 'sha256']);
const Content = row('sys_file', ['key', 'mime']);
const TEXT = /^(text\/|application\/(json|xml|csv))/;
const MODEL_IMAGE = /^image\/(jpeg|png|webp|gif)$/;
const TEXT_CHARS = 64 * 1024;
const refused = (message: string) => Effect.fail(BoltError.make('invalid_input', 'decode', message));

/** Only the member's own panel uploads can be attached, with one query for the whole set. */
export const attachmentsFor = Effect.fn('Agents.attachments')(function* (
	db: TenantDbShape,
	member: string,
	refs: readonly Json[]
) {
	const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Ref))(refs).pipe(
		Effect.mapError((error) =>
			BoltError.make('invalid_input', 'decode', 'An attachment is a stored file reference.', error)
		)
	);
	if (decoded.length > MODEL_FILES.count)
		return yield* refused(`Attach at most ${MODEL_FILES.count} files.`);
	const ids = decoded.map((ref) => ref.id);
	const rows = yield* db.rows(Stored, {
		text: `SELECT id, name, mime, size, sha256 FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND field IN ('sys_conversation.inputs', 'sys_conversation.outputs') AND created_by = $2`,
		params: [JSON.stringify(ids), member]
	});
	const byId = new Map(rows.map((file) => [file.id, file]));
	return yield* Effect.forEach(ids, (id) => {
		const file = byId.get(id);
		return file === undefined
			? refused('An attachment is not a file you uploaded here.')
			: Effect.succeed({
					id,
					name: file.name,
					mime: file.mime,
					bytes: file.size,
					sha256: file.sha256
				});
	});
});

/**
 * The host-independent attachment reader: an image as model-compatible bytes, a text file as its text. Every other file
 * is parsed by `read_file` (plan 12), never here.
 */
export function file_attachments(
	db: TenantDbShape,
	files: Files['Service'],
	images: Images['Service']
): AttachmentPort {
	return {
		read: Effect.fn('Agents.readAttachment')(function* (file: Json) {
			const ref = yield* Schema.decodeUnknownEffect(Ref)(file).pipe(
				Effect.mapError((error) => BoltError.make('invalid_input', 'decode', error.message, error))
			);
			const stored = yield* db.one(Content, {
				text: 'SELECT key, mime FROM sys_file WHERE id = $1',
				params: [ref.id]
			});
			if (Option.isNone(stored)) return yield* refused('the file is not stored');
			const mime = stored.value.mime,
				name = ref.name ?? '';
			if (!mime.startsWith('image/') && !TEXT.test(mime))
				return yield* refused(
					`${name || 'this file'} (${mime}): read_file { id: '${ref.id}' } parses it`
				);
			const bytes = yield* files.get(stored.value.key, MODEL_FILES.bytes);
			// MIME owns visual reads: a model's format guess must not hide the original evidence.
			if (mime.startsWith('image/'))
				return MODEL_IMAGE.test(mime)
					? { mime, bytes }
					: {
							mime: 'image/jpeg',
							bytes: yield* image_jpeg(bytes, 2048).pipe(Effect.provideService(Images, images))
						};
			const text = new TextDecoder().decode(bytes);
			return {
				name,
				mime,
				text: text.slice(0, TEXT_CHARS),
				...(text.length > TEXT_CHARS
					? {
							truncated: `only the first ${TEXT_CHARS} of ${text.length} characters are shown; read_file { id: '${ref.id}', from } reads on`
						}
					: {})
			};
		})
	};
}

/**
 * What triage sees of a message's files: each one's metadata, and the images among them. Nothing is parsed here. Read
 * only files already attached to this pending conversation; never follow URLs supplied in a caption.
 */
export const triageAttachments = Effect.fn('Agents.triageAttachments')(function* (
	db: TenantDbShape,
	ports: {
		files: Files['Service'];
		images: Images['Service'];
		logs: Logs['Service'];
	},
	messages: readonly { id: string; files: readonly MessageFile[] }[],
	context: { now: string; conversation: string }
) {
	const StoredMedia = row('sys_file', ['id', 'name', 'mime', 'size', 'key', 'sha256']);
	const ids = [
		...new Set(messages.flatMap((m) => m.files.flatMap((f) => (f.id === undefined ? [] : [f.id]))))
	];
	const stored =
		ids.length === 0
			? []
			: yield* db.rows(StoredMedia, {
					text: "SELECT id, name, mime, size, key, sha256 FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND field IN ('sys_conversation.inputs','sys_conversation.outputs')",
					params: [JSON.stringify(ids)]
				});
	const byId = new Map(stored.map((f) => [f.id, f]));
	let bytes = 0,
		images = 0;
	return new Map(
		yield* Effect.forEach(messages, (message) =>
			Effect.gen(function* () {
				const attachments: Json[] = [],
					parts: Json[] = [];
				let unread = false;
				const addImage = Effect.fn('Agents.triageImage')(function* (image: {
					key: string;
					size: number;
				}) {
					if (++images > 4 || image.size > 8 * 1024 * 1024) return undefined;
					const jpeg = yield* image_jpeg(
						yield* ports.files.get(image.key, 8 * 1024 * 1024),
						1024
					).pipe(Effect.provideService(Images, ports.images));
					const label = `message-${message.id}-image-${images}`;
					parts.push(label, {
						type: 'image_url',
						image_url: { url: `data:image/jpeg;base64,${toBase64(jpeg)}` }
					});
					return label;
				});
				for (const ref of message.files) {
					const file = ref.id === undefined ? undefined : byId.get(ref.id);
					const metadata = {
						name: file?.name ?? ref.name ?? 'file',
						mime: file?.mime ?? ref.mime ?? '',
						...(file === undefined ? {} : { size: file.size }),
						...(ref.caption === undefined ? {} : { caption: ref.caption.slice(0, 6000) })
					};
					const failedRead = (reason: string) =>
						ports.logs
							.write({
								at: context.now,
								severity: 'warn',
								event: 'ingest.failed',
								invocation: message.id,
								conversation: context.conversation,
								run: null,
								turn: null,
								attributes: { file: file?.id ?? null, mime: metadata.mime, reason }
							})
							.pipe(Effect.as({ unread: true } as const));
					const content = yield* Effect.gen(function* () {
						if (file === undefined || route(file.mime, file.name) !== 'image') return {};
						if (file.size > 8 * 1024 * 1024 || (bytes += file.size) > 20 * 1024 * 1024)
							return { unread: true };
						const image = yield* addImage(file);
						return image === undefined ? { unread: true } : { image };
					}).pipe(
						Effect.timeoutOption('10 seconds'),
						Effect.tap((result) =>
							Option.isNone(result)
								? failedRead('Attachment preparation exceeded its time budget.')
								: Effect.void
						),
						Effect.map((result) => Option.getOrElse(result, () => ({ unread: true }) as const)),
						Effect.catch((error) => failedRead(error.message.slice(0, 300)))
					);
					unread ||= 'unread' in content;
					attachments.push({ ...metadata, ...content });
				}
				return [message.id, { attachments, parts, unread }] as const;
			})
		)
	);
});
