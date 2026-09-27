// The Office parser, run in a worker by documents.ts, never on the host event loop.
import { parentPort, workerData } from 'node:worker_threads';

const { bytes, mime } = workerData as { bytes: unknown; mime: unknown };
if (!(bytes instanceof Uint8Array) || typeof mime !== 'string') throw new Error('Office bytes and type required.');
if (parentPort === null) throw new Error('Document worker required.');
const sections: string[] = [];
let size = 0;
const append = (text: string) => {
	size += Buffer.byteLength(text) + 1;
	if (size > 2 * 1024 * 1024) throw new Error('Document text exceeds the 2 MiB extraction limit.');
	sections.push(text);
};
if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
	const mammoth = await import('mammoth');
	const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
	append(result.value);
} else if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
	const { default: ExcelJS } = await import('exceljs');
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
	if (workbook.worksheets.length > 200)
		throw new Error('Workbook exceeds the 200-sheet extraction limit.');
	for (const sheet of workbook.worksheets) {
		append(`[Sheet: ${sheet.name}]`);
		sheet.eachRow((row) =>
			row.eachCell((cell) => {
				const formula = cell.formula;
				append(
					`${cell.address}: ${cell.text}${formula ? ` [formula: ${formula}; cached result only]` : ''}`
				);
			})
		);
	}
} else throw new Error('Unsupported Office document.');
const body = sections.join('\n').trim();
if (!body) throw new Error('Document has no extractable text.');
parentPort.postMessage({ body });
