import { Effect, Option, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Images, type Files, type Convert, type Logs } from '../ports.ts';
import { imageJpeg } from '../files/image.ts';
import { row } from '../system/rows.ts';
import { MODEL_FILES } from './ai.ts';
import type { AttachmentPort } from './tools.ts';
import type { FileRef as MessageFile } from './schema.ts';
import { cached, plain, route, stash, transcriptOf } from './ingest.ts';
import { toBase64 } from '../crypto.ts';

const Ref = Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) });
const Stored = row('sys_file', ['id', 'name', 'mime', 'size', 'sha256']);
const Content = row('sys_file', ['key', 'mime']);
const TEXT = /^(text\/|application\/(json|xml|csv))/;
const MODEL_IMAGE = /^image\/(jpeg|png|webp|gif)$/;
const TEXT_CHARS = 64 * 1024;
const refused = (message: string) => Effect.fail(BoltError.make('invalidInput', 'decode', message));

/** Only the member's own panel uploads can be attached, with one query for the whole set. */
export const attachmentsFor = Effect.fn('Agents.attachments')(function* (
	db: TenantDbShape,
	member: string,
	refs: readonly Json[]
) {
	const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Ref))(refs).pipe(
		Effect.mapError((error) =>
			BoltError.make('invalidInput', 'decode', 'An attachment is a stored file reference.', error)
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
	if (rows.reduce((bytes, file) => bytes + file.size, 0) > MODEL_FILES.bytes)
		return yield* refused('Attach at most 20 MiB in one message.');
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
 * is read through `ingest` (plan 12), never here.
 */
export function fileAttachments(
	db: TenantDbShape,
	files: Files['Service'],
	images: Images['Service']
): AttachmentPort {
	return {
		read: Effect.fn('Agents.readAttachment')(function* (file: Json) {
			const ref = yield* Schema.decodeUnknownEffect(Ref)(file).pipe(
				Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error))
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
					`${name || 'this file'} (${mime}) is read through ingest: call ingest { id: '${ref.id}' }, then read_file { output } windows it`
				);
			const bytes = yield* files.get(stored.value.key, MODEL_FILES.bytes);
			// MIME owns visual reads: a model's format guess must not hide the original evidence.
			if (mime.startsWith('image/'))
				return MODEL_IMAGE.test(mime)
					? { mime, bytes }
					: {
							mime: 'image/jpeg',
							bytes: yield* imageJpeg(bytes, 2048).pipe(Effect.provideService(Images, images))
						};
			const text = new TextDecoder().decode(bytes);
			return {
				name,
				mime,
				text: text.slice(0, TEXT_CHARS),
				...(text.length > TEXT_CHARS
					? {
							truncated: `only the first ${TEXT_CHARS} of ${text.length} characters are shown; the rest: ingest { id: '${ref.id}' } and read_file windows`
						}
					: {})
			};
		})
	};
}

/** Read only files already attached to this pending conversation; never follow URLs supplied in a caption. */
export const triageAttachments = Effect.fn('Agents.triageAttachments')(function* (
	db: TenantDbShape,
	ports: {
		files: Files['Service'];
		images: Images['Service'];
		convert: Convert['Service'];
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
		images = 0,
		textChars = 0;
	return new Map(
		yield* Effect.forEach(messages, (message) =>
			Effect.gen(function* () {
				const attachments: Json[] = [],
					parts: Json[] = [];
				let unread = false;
				// Original photos and extracted document pages share the same visual and byte budgets.
				const addImage = Effect.fn('Agents.triageImage')(function* (image: {
					key: string;
					size: number;
				}) {
					if (++images > 4 || image.size > 8 * 1024 * 1024) return undefined;
					const jpeg = yield* imageJpeg(
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
						if (ref.text !== undefined && ref.text.trim() !== '')
							return { text: ref.text.slice(0, 12000), truncated: ref.text.length > 12000 };
						if (
							file === undefined ||
							file.size > 8 * 1024 * 1024 ||
							(bytes += file.size) > 20 * 1024 * 1024
						)
							return { unread: true };
						const how = route(file.mime, file.name);
						if (how === 'unsupported') return { unread: true };
						if (how === 'image') {
							const image = yield* addImage(file);
							return image === undefined ? { unread: true } : { image };
						}
						if (how === 'text') {
							const text = new TextDecoder().decode(
								yield* ports.files.get(file.key, 8 * 1024 * 1024)
							);
							return { text: text.slice(0, 12000), truncated: text.length > 12000 };
						}
						let parsed = yield* cached(db, ports.files, file.sha256);
						if (parsed === undefined) {
							if (ports.convert.ingest === undefined) return { unread: true };
							const got = yield* ports.convert.ingest(
								{ ...file, bytes: yield* ports.files.get(file.key, 8 * 1024 * 1024) },
								{}
							);
							if ('unsupported' in got) return { unread: true };
							const usage = got.meta.usage;
							if (usage !== undefined)
								yield* ports.logs.write({
									at: context.now,
									severity: 'info',
									event: 'ai.call',
									invocation: message.id,
									conversation: context.conversation,
									run: null,
									turn: null,
									attributes: {
										calls: usage.calls,
										model: usage.model,
										input: usage.input,
										output: usage.output,
										cost: usage.cost,
										facility: 'convert.ingest',
										category: how === 'audio' ? 'transcription' : 'attachment',
										settlement: usage.calls.length === 0 ? 'attention' : 'pending'
									}
								});
							yield* ports.logs.write({
								at: context.now,
								severity: 'info',
								event: 'ingest.convert',
								invocation: message.id,
								conversation: context.conversation,
								run: null,
								turn: null,
								attributes: {
									sha256: file.sha256,
									mime: file.mime,
									kind: got.kind,
									cached: false,
									...got.meta.stats
								}
							});
							parsed = yield* stash(
								db,
								ports.files,
								{
									sha256: file.sha256,
									base: file.name.replace(/\.[^./]*$/, '').replaceAll('/', '_') || 'file',
									member: null,
									now: context.now
								},
								got
							);
						}
						const main = new TextDecoder().decode(
							yield* ports.files.get(parsed.main.key, 8 * 1024 * 1024)
						);
						const transcript =
							how === 'audio' && parsed.kind === 'document' ? transcriptOf(main) : undefined;
						const text =
							transcript !== undefined
								? transcript.segments.map((s) => `${s.speaker}: ${s.text}`).join('\n')
								: parsed.kind === 'document'
									? plain(main)
									: main;
						const documentImages: string[] = [];
						let incomplete = false;
						for (const image of parsed.files.filter((part) => part.mime.startsWith('image/'))) {
							if ((bytes += image.size) > 20 * 1024 * 1024) {
								incomplete = true;
								break;
							}
							const label = yield* addImage(image);
							if (label === undefined) {
								incomplete = true;
								break;
							}
							documentImages.push(label);
						}
						return {
							text: text.slice(0, 12000),
							truncated: text.length > 12000,
							unread: incomplete || (text.trim() === '' && documentImages.length === 0),
							...(documentImages.length === 0 ? {} : { images: documentImages }),
							...(how === 'audio' ? { transcript: true } : {})
						};
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
					const retained =
						'text' in content &&
						typeof content.text === 'string' &&
						(textChars += content.text.length) > 48000
							? { unread: true }
							: content;
					unread ||=
						('unread' in retained && retained.unread === true) ||
						('truncated' in retained && retained.truncated === true);
					attachments.push({ ...metadata, ...retained });
				}
				return [message.id, { attachments, parts, unread }] as const;
			})
		)
	);
});
