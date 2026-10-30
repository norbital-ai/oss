// One router for every file a model sees. A format goes whole only where the model takes it natively (its published
// input modalities); a PDF otherwise splits page by page into the document's own text and its own pixels. Never a
// provider's OCR presented as the document, and an unreadable file is an explicit answer.
import { Effect, Option } from 'effect';
import { csvOf } from '@norbital-ai/std/csv';
import type { Json } from '../../decl/values.ts';
import type { EngineError } from '../errors.ts';
import { xlsxCells, xlsxSheets } from '../files/xlsx.ts';
import { toBase64 } from '../crypto.ts';
import { MODEL_FILES } from './ai.ts';

const TEXT = /^(text\/|application\/(json|csv|xml|[\w.-]+\+(json|xml))$)/;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const dataUrl = (f: { mime: string; bytes: Uint8Array }) =>
	`data:${f.mime};base64,${toBase64(f.bytes)}`;

/** One file as a chat part: a PDF goes as a file part only to a model that takes `pdf`; `inputs` unknown takes none. */
export function filePart(
	f: { mime: string; bytes: Uint8Array },
	name: string,
	inputs: readonly string[] | undefined
): Json {
	if (f.mime.startsWith('image/')) return { type: 'image_url', image_url: { url: dataUrl(f) } };
	if (f.mime === 'application/pdf')
		return inputs?.includes('pdf') === true
			? { type: 'file', file: { filename: name, file_data: dataUrl(f) } }
			: {
					type: 'text',
					text: `${name}: a PDF this model cannot take whole; read_file sends its own text and its scanned pages as images`
				};
	if (TEXT.test(f.mime))
		return { type: 'text', text: `${name} (${f.mime}):\n${new TextDecoder().decode(f.bytes)}` };
	if (f.mime === XLSX)
		return {
			type: 'text',
			text: xlsxSheets(f.bytes)
				.map((sheet, i) => `${name} sheet ${i} "${sheet}" (CSV):\n${csvOf(xlsxCells(f.bytes, i))}`)
				.join('\n')
		};
	return {
		type: 'text',
		text: `${name}: a ${f.mime} file cannot be shown to you; tell the person and ask for a photo, a PDF or a text version`
	};
}

/** A page is read by eye when it has next to no text of its own (a scan with a stamp) or its text is an OCR layer. */
export const scanned = (page: string) =>
	page.trim().length < 80 ||
	page.includes('(no extractable text') ||
	page.includes('(image-only page');

export type DocumentPorts = {
	documentText?:
		((file: { mime: string; bytes: Uint8Array }) => Effect.Effect<string, EngineError>) | undefined;
	documentPages?:
		| ((
				file: { mime: string; bytes: Uint8Array },
				pages: number
		  ) => Effect.Effect<readonly Uint8Array[], EngineError>)
		| undefined;
};

/**
 * A PDF decided per page: a page with a real text layer is its text; a scanned page is its rendered JPEG. `unread`
 * names scanned pages this host could not render (none rendered, or past the files a model call carries).
 */
export const ingestPdf = Effect.fn('Agents.ingest')(function* (
	doc: { mime: string; bytes: Uint8Array },
	ports: DocumentPorts
) {
	const layer =
		ports.documentText === undefined
			? undefined
			: yield* ports
					.documentText(doc)
					.pipe(
						Effect.tapCause(Effect.logWarning),
						Effect.option,
						Effect.map(Option.getOrUndefined)
					);
	const texts = layer?.split(/\[Page \d+\]\n?/).slice(1) ?? [];
	// no text layer at all: every page is a scan, as many as a call carries
	const scans =
		texts.length === 0
			? Array.from({ length: MODEL_FILES.count }, (_, n) => n + 1)
			: texts.flatMap((t, n) => (scanned(t) ? [n + 1] : []));
	const rendered =
		scans.length === 0 || ports.documentPages === undefined
			? []
			: yield* ports.documentPages(doc, Math.min(Math.max(...scans), MODEL_FILES.count)).pipe(
					Effect.tapCause(Effect.logWarning),
					Effect.option,
					Effect.map((o) => Option.getOrElse(o, () => []))
				);
	const images = scans.flatMap((page) => {
		const bytes = rendered[page - 1];
		return bytes === undefined ? [] : [{ page, bytes }];
	});
	return {
		text: texts
			.map(
				(t, n) =>
					`[Page ${n + 1}]\n${scans.includes(n + 1) ? '(scanned: read it from its page image)' : t.trim()}`
			)
			.join('\n\n'),
		images,
		unread:
			texts.length === 0 && images.length > 0
				? []
				: scans.filter((page) => !images.some((i) => i.page === page))
	};
});
