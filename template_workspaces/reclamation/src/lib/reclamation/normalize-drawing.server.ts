import { Dwg_File_Type, LibreDwg, type DwgEntity } from '@mlightcad/libredwg-web';
import type { DxfDocument, DxfEntity, DxfEntityType } from './dxf.js';
import { detectFormat, type RawDocument } from './extract.js';

let libreDwg: ReturnType<typeof LibreDwg.create> | null = null;

function decoder() {
	libreDwg ??= LibreDwg.create();
	return libreDwg;
}

type PointLike = { readonly x?: number; readonly y?: number; readonly z?: number };
type EntityLike = DwgEntity & Record<string, unknown>;

function point(value: unknown): readonly [number, number, number] | null {
	if (typeof value !== 'object' || value === null) return null;
	const candidate = value as PointLike;
	const x = Number(candidate.x);
	const y = Number(candidate.y);
	const z = Number(candidate.z ?? 0);
	return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : null;
}

function points(value: unknown): readonly (readonly [number, number, number])[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const parsed = point(entry);
		return parsed ? [parsed] : [];
	});
}

function decodedEntity(entity: EntityLike): DxfEntity | null {
	const layer = String(entity.layer || '0');
	const flag = Number(entity.flag ?? 0);
	const common = (
		type: DxfEntityType,
		vertices: DxfEntity['vertices'],
		closed = false
	): DxfEntity => ({
		type,
		layer,
		vertices,
		closed
	});

	switch (entity.type) {
		case 'LINE': {
			const start = point(entity.startPoint);
			const end = point(entity.endPoint);
			return start && end ? common('LINE', [start, end]) : null;
		}
		case 'LWPOLYLINE':
			return common('LWPOLYLINE', points(entity.vertices), (flag & 1) === 1);
		case 'POLYLINE2D':
		case 'POLYLINE3D':
			return common('POLYLINE', points(entity.vertices), (flag & 1) === 1);
		case 'POINT': {
			const position = point(entity.position);
			return position ? common('POINT', [position]) : null;
		}
		case 'TEXT': {
			const position = point(entity.startPoint);
			return {
				...common('TEXT', position ? [position] : []),
				text: String(entity.text ?? '')
			};
		}
		case 'MTEXT': {
			const position = point(entity.insertionPoint);
			return {
				...common('MTEXT', position ? [position] : []),
				text: String(entity.text ?? '')
			};
		}
		default:
			return null;
	}
}

/** Decode a native DWG to the same entity model used by the DXF reader. */
async function normalizeDwg(document: RawDocument): Promise<RawDocument> {
	const runtime = await decoder();
	const data = runtime.dwg_read_data(document.bytes.slice().buffer, Dwg_File_Type.DWG);
	if (data === undefined) {
		throw new Error(`LibreDWG could not decode "${document.fileName ?? 'drawing.dwg'}".`);
	}
	try {
		const database = runtime.convert(data);
		const entities: DxfEntity[] = [];
		const layers = new Set<string>();
		const skipped: Record<string, number> = {};
		for (const source of database.entities as EntityLike[]) {
			const entity = decodedEntity(source);
			if (entity) {
				entities.push(entity);
				layers.add(entity.layer);
			} else {
				skipped[source.type] = (skipped[source.type] ?? 0) + 1;
			}
		}
		const decodedCad: DxfDocument = {
			entities,
			layers: [...layers].sort(),
			skipped,
			insUnits: null
		};
		return { ...document, decodedCad };
	} finally {
		runtime.dwg_free(data);
	}
}

/**
 * Confirm whether a tender PDF actually carries vector drawing operators.
 *
 * PDF coordinates are plotted sheet coordinates, not engineering station/level
 * coordinates. Returning them as section geometry would create the same false
 * reconstruction this normaliser is meant to prevent, so a vector sheet is
 * identified precisely and then held for semantic labelling and scale
 * calibration by the document agent.
 */
async function inspectPdf(document: RawDocument): Promise<never> {
	const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = getDocument({
		data: document.bytes.slice(),
		disableFontFace: true,
		isEvalSupported: false,
		useWorkerFetch: false
	});
	const pdf = await task.promise;
	let vectorPaths = 0;
	let images = 0;
	try {
		const imageOps = new Set([
			OPS.paintImageXObject,
			OPS.paintInlineImageXObject,
			OPS.paintImageMaskXObject,
			OPS.paintSolidColorImageMask
		]);
		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			const page = await pdf.getPage(pageNumber);
			const operators = await page.getOperatorList();
			for (const operation of operators.fnArray) {
				if (operation === OPS.constructPath) vectorPaths++;
				if (imageOps.has(operation)) images++;
			}
		}
	} finally {
		await pdf.destroy();
	}

	if (vectorPaths === 0) {
		throw new Error(
			`Cross-section PDF "${document.fileName ?? 'upload.pdf'}" contains no vector path operators; a raster-only sheet cannot supply exact CAD geometry.`
		);
	}
	throw new Error(
		`Cross-section PDF "${document.fileName ?? 'upload.pdf'}" is vector-based (${vectorPaths.toLocaleString()} path batches, ${images.toLocaleString()} embedded images), ` +
			'but its plotted sheet coordinates still need section-boundary recognition and dimension-based scale calibration before they can become engineering geometry. The source has been recognised correctly; reconstruction is blocked instead of inventing a profile.'
	);
}

/** Native drawing normalisation happens before the synchronous geometry engine. */
export async function normalizeDrawing(document: RawDocument): Promise<RawDocument> {
	const format = detectFormat(document);
	if (format === 'dwg') return normalizeDwg(document);
	if (format === 'pdf') return inspectPdf(document);
	return document;
}
