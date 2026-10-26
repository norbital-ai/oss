import { Effect, Option, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Images, type Files } from '../ports.ts';
import { imageJpeg } from '../files/image.ts';
import { row } from '../system/rows.ts';
import { MODEL_FILES } from './ai.ts';
import type { AttachmentPort } from './tools.ts';
import { xlsxCells, xlsxSheets } from '../files/xlsx.ts';

const Ref = Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) });
const Stored = row('sys_file', ['id', 'name', 'mime', 'size']);
const Content = row('sys_file', ['key', 'mime']);
const TEXT = /^(text\/|application\/(json|xml|csv))/;
const MODEL_IMAGE = /^image\/(jpeg|png|webp|gif)$/;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET_ROWS = 2000;
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
		text: `SELECT id, name, mime, size FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND field IN ('sys_conversation.inputs', 'sys_conversation.outputs') AND created_by = $2`,
		params: [JSON.stringify(ids), member]
	});
	const byId = new Map(rows.map((file) => [file.id, file]));
	if (rows.reduce((bytes, file) => bytes + file.size, 0) > MODEL_FILES.bytes)
		return yield* refused('Attach at most 20 MiB in one message.');
	return yield* Effect.forEach(ids, (id) => {
		const file = byId.get(id);
		return file === undefined
			? refused('An attachment is not a file you uploaded here.')
			: Effect.succeed({ id, name: file.name, mime: file.mime, bytes: file.size });
	});
});

/** The host-independent attachment reader; model-compatible images and documents remain bytes. */
export function fileAttachments(
	db: TenantDbShape,
	files: Files['Service'],
	images: Images['Service']
): AttachmentPort {
	return {
		read: Effect.fn('Agents.readAttachment')(function* (
			file: Json,
			as: 'text' | 'image' | 'sheet' | 'document',
			sheet = 0
		) {
			const ref = yield* Schema.decodeUnknownEffect(Ref)(file).pipe(
				Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error))
			);
			const stored = yield* db.one(Content, {
				text: 'SELECT key, mime FROM sys_file WHERE id = $1',
				params: [ref.id]
			});
			if (Option.isNone(stored)) return yield* refused('the file is not stored');
			const mime = stored.value.mime,
				bytes = yield* files.get(stored.value.key, MODEL_FILES.bytes),
				name = ref.name ?? '';
			if (as === 'image') {
				if (!mime.startsWith('image/')) return yield* refused(`a ${mime} file is not an image`);
				return MODEL_IMAGE.test(mime)
					? { mime, bytes }
					: {
							mime: 'image/jpeg',
							bytes: yield* imageJpeg(bytes, 2048).pipe(Effect.provideService(Images, images))
						};
			}
			if (as === 'document') {
				if (mime !== 'application/pdf') return yield* refused(`a ${mime} file is not a PDF`);
				return { mime, bytes };
			}
			if (mime === XLSX || name.toLowerCase().endsWith('.xlsx')) {
				const workbook = yield* Effect.try({
					try: () => ({ sheets: xlsxSheets(bytes), cells: xlsxCells(bytes, sheet) }),
					catch: (error) =>
						BoltError.make(
							'invalidInput',
							'decode',
							error instanceof Error ? error.message : String(error),
							error
						)
				});
				const title = workbook.sheets[sheet];
				if (title === undefined) return yield* refused(`worksheet ${sheet} does not exist`);
				return {
					name,
					mime,
					sheets: workbook.sheets,
					sheet: title,
					rows: workbook.cells.length,
					cells: workbook.cells.slice(0, SHEET_ROWS),
					...(workbook.cells.length > SHEET_ROWS
						? { truncated: `only the first ${SHEET_ROWS} rows are shown` }
						: {})
				};
			}
			if (!TEXT.test(mime)) return yield* refused(`a ${mime} file cannot be read as ${as} here`);
			return { name, mime, text: new TextDecoder().decode(bytes).slice(0, 64 * 1024) };
		})
	};
}
