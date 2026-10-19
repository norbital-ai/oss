// Office parsing stays in an isolated native worker.
import { Effect, Schema } from 'effect';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { parentPort, workerData } from 'node:worker_threads';
import { OfficeResult } from './documents.ts';
class OfficeFailure extends Schema.TaggedError<OfficeFailure>()('OfficeFailure', {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect())
}) {}
const failed = (cause: unknown) =>
	new OfficeFailure({ message: cause instanceof Error ? cause.message : String(cause), cause });
const parse = Effect.gen(function* () {
	const { bytes, mime } = yield* Schema.decodeUnknownEffect(
		Schema.Struct({ bytes: Schema.Uint8Array, mime: Schema.String })
	)(workerData).pipe(Effect.mapError(failed));
	const port = parentPort;
	if (port === null)
		return yield* Effect.fail(new OfficeFailure({ message: 'Document worker required.' }));
	const sections: string[] = [];
	let size = 0;
	const append = (text: string) => {
		size += Buffer.byteLength(text) + 1;
		if (size > 2 * 1024 * 1024)
			throw new OfficeFailure({ message: 'Document text exceeds the 2 MiB extraction limit.' });
		sections.push(text);
	};
	if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
		const mammoth = yield* Effect.tryPromise({ try: () => import('mammoth'), catch: failed });
		const result = yield* Effect.tryPromise({
			try: () => mammoth.extractRawText({ buffer: Buffer.from(bytes) }),
			catch: failed
		});
		yield* Effect.try({ try: () => append(result.value), catch: failed });
	} else if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
		const { default: ExcelJS } = yield* Effect.tryPromise({
			try: () => import('exceljs'),
			catch: failed
		});
		const workbook = new ExcelJS.Workbook();
		yield* Effect.tryPromise({
			try: () => workbook.xlsx.load(Uint8Array.from(bytes).buffer),
			catch: failed
		});
		if (workbook.worksheets.length > 200)
			return yield* Effect.fail(
				new OfficeFailure({ message: 'Workbook exceeds the 200-sheet extraction limit.' })
			);
		yield* Effect.try({
			try: () => {
				for (const sheet of workbook.worksheets) {
					append(`[Sheet: ${sheet.name}]`);
					sheet.eachRow((row) =>
						row.eachCell((cell) =>
							append(
								`${cell.address}: ${cell.text}${cell.formula ? ` [formula: ${cell.formula}; cached result only]` : ''}`
							)
						)
					);
				}
			},
			catch: failed
		});
	} else return yield* Effect.fail(new OfficeFailure({ message: 'Unsupported Office document.' }));
	const body = sections.join('\n').trim();
	if (!body)
		return yield* Effect.fail(new OfficeFailure({ message: 'Document has no extractable text.' }));
	port.postMessage(OfficeResult.cases.Extracted.make({ body }));
});
NodeRuntime.runMain(
	parse.pipe(
		Effect.catchTag('OfficeFailure', (error) =>
			Effect.sync(() => {
				if (parentPort === null) throw error;
				parentPort.postMessage(OfficeResult.cases.Failed.make({ message: error.message }));
			})
		)
	)
);
