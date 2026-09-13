// repository-health:allow FILE1 -- Parser worker entrypoint loaded by documents.ts, never on the host event loop.
import { parentPort, workerData } from 'node:worker_threads';
import { Schema } from 'effect';

const { bytes, mime } = Schema.decodeUnknownSync(
	Schema.Struct({ bytes: Schema.Uint8Array, mime: Schema.String })
)(workerData);
if (parentPort === null) throw new Error('Document worker required.');
const sections: string[] = [];
// repository-health:allow STATE1 -- One document per dedicated worker; documents.ts terminates it after the result or timeout.
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
