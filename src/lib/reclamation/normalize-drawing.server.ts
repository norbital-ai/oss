import { detectFormat, type RawDocument } from './extract.js';

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
		// Pages are inspected one at a time on purpose: a single decoded operator list is the peak,
		// inside the ~139 MiB tenant envelope `refuseDwg` names; holding every page's operators at
		// once would multiply that peak by the page count.
		// stupidity:allow A6 -- the sequencing is the point.
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

/**
 * Refuse native DWG, in the same terms the floor-plan reader already uses.
 *
 * The engine runs inside a pooled tenant runtime with roughly 139 MiB of memory
 * available to it in total. Decoding DWG needs LibreDWG, an Emscripten build
 * whose heap reaches ~66 MiB on first use and — like every Emscripten heap —
 * never shrinks, so one decode claimed that memory for the rest of that
 * runtime's life and left too little for the reconstruction itself. The result
 * was not a bad model but a dead process: the guest kernel killed the runtime
 * mid-request and the caller saw a generic error with nothing to act on.
 *
 * DXF is not a workaround here, it is the format the rest of this template
 * already runs on — `extractPlan` has always required it for floor plans, in
 * these words — and every CAD application writes it. The refusal is explicit and
 * names the fix, so it reaches the user as a `failure_reason` on a failed
 * revision instead of as a runtime that stopped answering.
 */
function refuseDwg(document: RawDocument): never {
	throw new Error(
		`Cross-section document "${document.fileName ?? 'upload.dwg'}" is a native DWG, which this workspace does not read. ` +
			'DWG has to be exported to DXF first — every CAD application can write it, and the reconstruction reads DXF directly.'
	);
}

/**
 * Native drawing normalisation happens before the synchronous geometry engine.
 *
 * What remains is format triage: DXF, XYZ, CSV and JSON are already readable by
 * the extractor and pass straight through, while DWG and PDF are refused with a
 * reason naming what to supply instead.
 */
export async function normalizeDrawing(document: RawDocument): Promise<RawDocument> {
	const format = detectFormat(document);
	if (format === 'dwg') refuseDwg(document);
	if (format === 'pdf') return inspectPdf(document);
	return document;
}
