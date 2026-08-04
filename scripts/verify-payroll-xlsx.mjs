/**
 * The payroll workbook is a real XLSX archive with the period as its sheet name.
 *
 * This used to run off `pnpm build`, against the emitted `.norbital/dist/**` chunk — a custom build
 * script, which `generated-and-build.md` forbids inside a tenant workspace, and which additionally
 * asserted a bundler property (that the export lands in its own lazy chunk) rather than a payroll
 * fact. What is worth asserting is the behaviour, so it is asserted here, against the source module,
 * from `pnpm test`.
 *
 * It loads through Vite rather than Node's type-stripping runner because `export.ts` imports the
 * bare browser build of ExcelJS, which only resolves under Vite — the same reason
 * `verify-overtime-controls.mjs` is shaped this way.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import ExcelJS from 'exceljs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({
	root,
	appType: 'custom',
	logLevel: 'silent',
	server: { middlewareMode: true }
});

try {
	const { payrollReportXlsx } = await vite.ssrLoadModule(
		'/src/collections/payroll_runs/lib/export.ts'
	);

	const bytes = await payrollReportXlsx([{ period: 'verification', payslips: [] }]);
	const archive = Uint8Array.from(bytes);

	// "PK\x03\x04": an XLSX is a zip, and a workbook that failed to serialise is not one.
	assert.deepEqual([...archive.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(archive);
	assert.equal(workbook.getWorksheet('verification')?.name, 'verification');

	console.log(`Payroll XLSX verified (${archive.byteLength} bytes).`);
} finally {
	await vite.close();
}
