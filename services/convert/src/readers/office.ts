// Word and PowerPoint by office_oxide, a program that reads doc, docx and pptx into one document model: hidden text and
// deleted revisions left out, footnotes, text boxes, content controls, merged cells and nested tables kept. The
// OpenDocument formats, ppt and rtf go through LibreOffice, their reference reader, into the formats it reads.
import { basename, extname, join } from 'node:path';
import { Effect, Schema } from 'effect';
import { escape, inline, type Block, type Images } from '../blocks.ts';
import { scratch, tool } from './tools.ts';

interface Node {
	readonly type?: string | undefined;
	readonly text?: string | undefined;
	readonly bold?: boolean | undefined;
	readonly italic?: boolean | undefined;
	readonly marker?: string | null | undefined;
	readonly note_id?: number | undefined;
	readonly level?: number | undefined;
	readonly ordered?: boolean | undefined;
	readonly alt_text?: string | null | undefined;
	readonly data?: string | null | undefined;
	readonly format?: string | null | undefined;
	readonly content?: string | readonly Node[] | undefined;
	readonly rows?: readonly { readonly is_header?: boolean | undefined; readonly cells: readonly Cell[] }[] | undefined;
	readonly items?: readonly Item[] | undefined;
}
interface Cell {
	readonly content: readonly Node[];
	readonly col_span?: number | undefined;
	readonly row_span?: number | undefined;
}
interface Item {
	readonly content: readonly Node[];
	readonly nested?: Node | null | undefined;
}
const Nodes: Schema.Codec<readonly Node[], unknown> = Schema.Array(Schema.suspend(() => NodeSchema));
const CellSchema: Schema.Codec<Cell, unknown> = Schema.Struct({
	content: Nodes,
	col_span: Schema.optional(Schema.Number),
	row_span: Schema.optional(Schema.Number)
});
const ItemSchema: Schema.Codec<Item, unknown> = Schema.Struct({
	content: Nodes,
	nested: Schema.optional(Schema.NullOr(Schema.suspend(() => NodeSchema)))
});
// open by design: a type this reader has not met decodes, and its text still lands
const NodeSchema: Schema.Codec<Node, unknown> = Schema.Struct({
	type: Schema.optional(Schema.String),
	text: Schema.optional(Schema.String),
	bold: Schema.optional(Schema.Boolean),
	italic: Schema.optional(Schema.Boolean),
	marker: Schema.optional(Schema.NullOr(Schema.String)),
	note_id: Schema.optional(Schema.Number),
	level: Schema.optional(Schema.Number),
	ordered: Schema.optional(Schema.Boolean),
	alt_text: Schema.optional(Schema.NullOr(Schema.String)),
	data: Schema.optional(Schema.NullOr(Schema.String)),
	format: Schema.optional(Schema.NullOr(Schema.String)),
	content: Schema.optional(Schema.Union([Schema.String, Nodes])),
	rows: Schema.optional(
		Schema.Array(Schema.Struct({ is_header: Schema.optional(Schema.Boolean), cells: Schema.Array(CellSchema) }))
	),
	items: Schema.optional(Schema.Array(ItemSchema))
});
const Part = Schema.NullOr(Schema.Struct({ content: Nodes }));
const Section = Schema.Struct({
	title: Schema.optional(Schema.NullOr(Schema.String)),
	elements: Nodes,
	header: Schema.optional(Part),
	footer: Schema.optional(Part),
	first_page_header: Schema.optional(Part),
	first_page_footer: Schema.optional(Part),
	even_page_header: Schema.optional(Part),
	even_page_footer: Schema.optional(Part),
	speaker_notes: Schema.optional(Schema.NullOr(Nodes))
});
const Document = Schema.fromJsonString(Schema.Struct({ sections: Schema.Array(Section) }));

const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' };
const nodes = (content: Node['content']) => (typeof content === 'string' ? [] : (content ?? []));
/** A run of the same weight and slant stays one `strong` or `em`, however the file cut it. */
const htmlOf = (content: Node['content']) => {
	const runs: { html: string; strong: boolean; em: boolean }[] = [];
	for (const n of nodes(content)) {
		const strong = n.bold === true,
			em = n.italic === true,
			html =
				n.type === 'text'
					? escape(n.text ?? '')
					: n.type === 'line_break'
						? '<br>'
						: n.type === 'footnote_ref' || n.type === 'endnote_ref'
							? `[${n.marker ?? n.note_id}]`
							: '';
		const last = runs.at(-1);
		if (last !== undefined && last.strong === strong && last.em === em) last.html += html;
		else if (html !== '') runs.push({ html, strong, em });
	}
	return runs.map((run) => inline(run.html, run)).join('');
};
const blocks = (elements: readonly Node[], images: Images): Block[] =>
	elements.flatMap((n): Block[] => {
		switch (n.type) {
			case 'heading':
				return [{ t: 'h', level: n.level ?? 1, html: htmlOf(n.content) }];
			case 'paragraph': {
				const html = htmlOf(n.content);
				return html === '' ? [] : [{ t: 'p', html }];
			}
			case 'code_block':
				return [{ t: 'pre', text: typeof n.content === 'string' ? n.content : '' }];
			case 'list':
				return [
					{
						t: 'list',
						ordered: n.ordered === true,
						items: (n.items ?? []).map((item) => [
							...blocks(item.content, images),
							...(item.nested ? blocks([{ ...item.nested, type: 'list' }], images) : [])
						])
					}
				];
			case 'table':
				return [
					{
						t: 'table',
						rows: (n.rows ?? []).map((row) =>
							row.cells.map((cell) => ({
								// a cell running down out of the head would leave it: such a table has no head
								header: row.is_header === true && row.cells.every((c) => (c.row_span ?? 1) === 1),
								colspan: cell.col_span ?? 1,
								rowspan: cell.row_span ?? 1,
								blocks: blocks(cell.content, images)
							}))
						)
					}
				];
			case 'image': {
				const mime = MIME[n.format ?? ''];
				// emf, wmf, tiff and bmp have no browser pixels
				return mime === undefined || !n.data
					? []
					: [{ t: 'img', src: images.add(Buffer.from(n.data, 'base64'), mime), alt: n.alt_text ?? '' }];
			}
			case 'footnote':
			case 'endnote':
				return blocks(nodes(n.content), images).map((b, i) =>
					i === 0 && b.t === 'p' ? { ...b, html: `[${n.marker ?? n.note_id ?? ''}] ${b.html}` } : b
				);
			default:
				return blocks(nodes(n.content), images);
		}
	});

const failed = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));
/** A document's blocks: slides a section each, the title the model holds apart; a page's header and footer once. */
export const officeBlocks = (json: string, slides: boolean, images: Images) =>
	Effect.gen(function* () {
		const { sections } = yield* Schema.decodeUnknownEffect(Document)(json).pipe(Effect.mapError(failed));
		if (slides)
			return sections.map((s, i): Block => {
				const body = blocks(s.elements, images),
					title = escape(s.title ?? ''),
					titled = title === '' || body.some((b) => b.t === 'h' && b.html === title);
				return {
					t: 'section',
					kind: 'slide',
					n: i + 1,
					blocks: [
						...(titled ? [] : [{ t: 'h' as const, level: 1, html: title }]),
						...body,
						...blocks(s.speaker_notes ?? [], images)
					]
				};
			});
		const seen = new Set<string>();
		const once = sections.flatMap((s) =>
			[s.first_page_header, s.header, s.even_page_header, s.first_page_footer, s.footer, s.even_page_footer].flatMap(
				(part) => {
					const id = JSON.stringify(part?.content ?? []);
					if (part === undefined || part === null || seen.has(id)) return [];
					seen.add(id);
					return blocks(part.content, images);
				}
			)
		);
		return [...sections.flatMap((s) => blocks(s.elements, images)), ...once];
	});
/** office_oxide over a file on disk, its name telling the format. */
export const office = (path: string, slides: boolean, images: Images) =>
	tool('office-oxide', ['ir', path]).pipe(
		Effect.flatMap((stdout) => officeBlocks(stdout.toString('utf8'), slides, images))
	);
/** `path` converted by LibreOffice, in a profile of this read's own: the path of the file it wrote. */
export const converted = (path: string, to: string) =>
	Effect.gen(function* () {
		const out = yield* scratch;
		yield* tool('soffice', [
			'--headless',
			'--norestore',
			`-env:UserInstallation=file://${out}/profile`,
			'--convert-to',
			to,
			'--outdir',
			out,
			path
		]);
		return join(out, `${basename(path, extname(path))}.${to}`);
	});
