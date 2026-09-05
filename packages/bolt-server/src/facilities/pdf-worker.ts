// repository-health:allow FILE1 -- Worker-thread entrypoint loaded by documents.ts; importing it on the host thread would execute the parser in the wrong context.
import { parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const bytes: unknown = workerData;
if (!(bytes instanceof Uint8Array) || parentPort === null) throw new Error('PDF bytes required.');
const packageRoot = new URL('./', import.meta.resolve('pdfjs-dist/package.json'));
const loading = getDocument({
	data: bytes,
	stopAtErrors: true,
	useWorkerFetch: false,
	useWasm: false,
	verbosity: 0,
	cMapUrl: fileURLToPath(new URL('cmaps/', packageRoot)),
	cMapPacked: true,
	standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', packageRoot))
});
try {
	const document = await loading.promise;
	if (document.numPages > 200) throw new Error('PDF exceeds the 200-page extraction limit.');
	const pages: string[] = [];
	let textBytes = 0;
	for (let number = 1; number <= document.numPages; number++) {
		// repository-health:allow A6 -- Load and release one page at a time to bound parser memory and preserve document order.
		const page = await document.getPage(number);
		// repository-health:allow A6 -- Extract this page before loading the next; parallel decoding would defeat the memory bound.
		const content = await page.getTextContent();
		const text = content.items
			.map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
			.join('')
			.trim();
		if (text.length === 0)
			throw new Error(
				`PDF page ${number} has no extractable text. OCR is required; no partial evidence was returned.`
			);
		const section = `[Page ${number}]\n${text}`;
		textBytes += Buffer.byteLength(section, 'utf8') + 2;
		if (textBytes > 2 * 1024 * 1024)
			throw new Error('PDF text exceeds the 2 MiB extraction limit.');
		pages.push(section);
		page.cleanup();
	}
	parentPort.postMessage({ body: pages.join('\n\n'), pageCount: document.numPages });
} finally {
	await loading.destroy();
}
