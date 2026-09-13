import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { extractDocumentText } from '../src/facilities/documents.js';

const mime = {
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};
const extract = (bytes: Uint8Array, type: string) =>
	extractDocumentText(bytes, type, new AbortController().signal);

describe('bounded document extraction', () => {
	it('reads every populated XLSX sheet and cell, with formulas as inert text and cached results', async () => {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('Accounts');
		sheet.getCell('A1').value = 'Customer 客户';
		sheet.getCell('B2').value = 125;
		sheet.getCell('C3').value = { formula: 'B2*2', result: 250 };
		workbook.addWorksheet('Notes', { state: 'hidden' }).getCell('Z10').value = 'Retain all records';
		const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
		const result = await extract(bytes, mime.xlsx);
		expect(result.body).toContain('[Sheet: Accounts]\nA1: Customer 客户');
		expect(result.body).toContain('B2: 125');
		expect(result.body).toContain('C3: 250 [formula: B2*2; cached result only]');
		expect(result.body).toContain('[Sheet: Notes]\nZ10: Retain all records');
		expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
	});
	it('reads DOCX paragraphs and Unicode without rendering HTML', async () => {
		const bytes = await readFile(new URL('./assets/agent-document.docx', import.meta.url));
		const result = await extract(bytes, mime.docx);
		expect(result.body).toContain('CRM acceptance: retain customer records.');
		expect(result.body).toContain('Second paragraph: café 客户.');
	});
	it('refuses corrupt Office files, oversize bytes and cancellation without a partial answer', async () => {
		for (const type of Object.values(mime))
			await expect(extract(new Uint8Array([1, 2, 3]), type)).rejects.toThrow();
		await expect(extract(new Uint8Array(20 * 1024 * 1024 + 1), mime.xlsx)).rejects.toThrow(
			'20 MiB'
		);
		await expect(
			extractDocumentText(new Uint8Array([1]), mime.docx, AbortSignal.abort(new Error('cancelled')))
		).rejects.toThrow('cancelled');
	});
	it('refuses excessive extracted text rather than silently truncating', async () => {
		const workbook = new ExcelJS.Workbook();
		const sheet = workbook.addWorksheet('Large');
		for (let i = 1; i <= 80; i++) sheet.getCell(`A${i}`).value = 'x'.repeat(30_000);
		await expect(
			extract(new Uint8Array(await workbook.xlsx.writeBuffer()), mime.xlsx)
		).rejects.toThrow('2 MiB');
	});
});
