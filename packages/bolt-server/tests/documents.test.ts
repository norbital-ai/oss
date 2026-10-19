import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Fiber, Schema } from 'effect';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { extractDocumentText } from '../src/documents.ts';

const mime = {
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};
class FixtureFailure extends Schema.TaggedError<FixtureFailure>()('FixtureFailure', {
	message: Schema.String
}) {}
const fixture = <A>(read: () => Promise<A>) =>
	Effect.tryPromise({
		try: read,
		catch: (error) =>
			new FixtureFailure({ message: error instanceof Error ? error.message : String(error) })
	});
const extract = extractDocumentText;

describe('bounded document extraction', () => {
	it.live(
		'reads every populated XLSX sheet and cell, with formulas as inert text and cached results',
		() =>
			Effect.gen(function* () {
				const workbook = new ExcelJS.Workbook();
				const sheet = workbook.addWorksheet('Accounts');
				sheet.getCell('A1').value = 'Customer 客户';
				sheet.getCell('B2').value = 125;
				sheet.getCell('C3').value = { formula: 'B2*2', result: 250 };
				workbook.addWorksheet('Notes', { state: 'hidden' }).getCell('Z10').value =
					'Retain all records';
				const bytes = new Uint8Array(yield* fixture(() => workbook.xlsx.writeBuffer()));
				const result = yield* extract(bytes, mime.xlsx);
				expect(result.body).toContain('[Sheet: Accounts]\nA1: Customer 客户');
				expect(result.body).toContain('B2: 125');
				expect(result.body).toContain('C3: 250 [formula: B2*2; cached result only]');
				expect(result.body).toContain('[Sheet: Notes]\nZ10: Retain all records');
				expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
			})
	);
	it.live('reads DOCX paragraphs and Unicode without rendering HTML', () =>
		Effect.gen(function* () {
			const bytes = yield* fixture(() =>
				readFile(new URL('./assets/agent-document.docx', import.meta.url))
			);
			const result = yield* extract(bytes, mime.docx);
			expect(result.body).toContain('CRM acceptance: retain customer records.');
			expect(result.body).toContain('Second paragraph: café 客户.');
		})
	);
	it.live(
		'refuses corrupt Office files, oversize bytes and cancellation without a partial answer',
		() =>
			Effect.gen(function* () {
				for (const type of Object.values(mime))
					expect(yield* Effect.flip(extract(new Uint8Array([1, 2, 3]), type))).toBeInstanceOf(
						Error
					);
				expect(
					yield* Effect.flip(extract(new Uint8Array(20 * 1024 * 1024 + 1), mime.xlsx))
				).toMatchObject({ message: expect.stringContaining('20 MiB') });
				const cancelled = yield* extractDocumentText(new Uint8Array([1]), mime.docx).pipe(
					Effect.forkChild
				);
				yield* Fiber.interrupt(cancelled);
				expect(Exit.hasInterrupts(yield* Fiber.await(cancelled))).toBe(true);
			})
	);
	it.live('refuses excessive extracted text rather than silently truncating', () =>
		Effect.gen(function* () {
			const workbook = new ExcelJS.Workbook();
			const sheet = workbook.addWorksheet('Large');
			for (let i = 1; i <= 80; i++) sheet.getCell(`A${i}`).value = 'x'.repeat(30_000);
			expect(
				yield* Effect.flip(
					extract(new Uint8Array(yield* fixture(() => workbook.xlsx.writeBuffer())), mime.xlsx)
				)
			).toMatchObject({ message: expect.stringContaining('2 MiB') });
		})
	);
});
