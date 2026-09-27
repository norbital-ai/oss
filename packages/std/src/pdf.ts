// std/pdf (§3.7, §5.8.1, D1/D2): a document is pure data, rendered host-side by `ctx.files.pdf(doc, { name, for })`
// in an automation. Images and fonts are file handles, so no image bytes enter the guest.

/** The handle a stored file travels as (structural, so bolt's `FileRef` fits). */
type FileHandle = { readonly id: string; readonly name: string; readonly mime: string };
type TableCell = string | number | null;

/**
 * One block of a PDF document: a text paragraph, a table, an image (a file handle), vertical space, and the other layout blocks.
 */
export type PdfBlock =
	| { readonly text: string; readonly size?: number; readonly bold?: true; readonly align?: 'left' | 'center' | 'right' }
	| { readonly table: { readonly columns: readonly (string | { readonly label: string; readonly width?: number; readonly align?: 'left' | 'right' })[]; readonly rows: readonly (readonly TableCell[])[] } }
	| { readonly image: FileHandle; readonly width?: number }
	| { readonly spacer: number }
	| { readonly pageBreak: true };

/** `{ page, font?, blocks } satisfies PdfDoc`; a missing font is the built-in Latin default. */
export type PdfDoc = {
	readonly page: 'A4' | 'Letter';
	readonly landscape?: true;
	readonly font?: FileHandle;
	readonly blocks: readonly PdfBlock[];
};
