import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';

const templateRoot = path.resolve(import.meta.dirname, '..');
const serverChunks = path.join(templateRoot, '.norbital/dist/output/server/chunks');
const exportChunk = readdirSync(serverChunks).find((file) =>
	/^export-[A-Za-z0-9_-]+\.js$/.test(file)
);
assert.ok(exportChunk, 'HR server build did not emit the lazy payroll export chunk');

const builtExport = await import(pathToFileURL(path.join(serverChunks, exportChunk)).href);
const bytes = await builtExport.payrollReportXlsx([{ period: 'verification', payslips: [] }]);
const archive = Uint8Array.from(bytes);
assert.deepEqual([...archive.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(archive);
assert.equal(workbook.getWorksheet('verification')?.name, 'verification');
console.log(`Verified emitted payroll XLSX (${archive.byteLength} bytes).`);
