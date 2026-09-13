import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { Schema } from 'effect';

const DocumentText = Schema.Struct({
	body: Schema.NonEmptyString,
	pageCount: Schema.optionalKey(Schema.Natural)
});

/** Resolve text offline; parser CPU/memory are bounded independently of the host event loop. */
export async function extractDocumentText(
	bytes: Uint8Array,
	contentType: string,
	signal: AbortSignal
): Promise<{ body: string; sha256: string; pageCount?: number }> {
	signal.throwIfAborted();
	if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024)
		throw new Error('Documents must contain between 1 byte and 20 MiB.');
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
	const office = [
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	].includes(mime);
	if (mime !== 'application/pdf' && !office) {
		if (!/^(text\/[\w.+-]+|application\/(csv|json|(?:[\w.-]+\+)?xml))$/.test(mime))
			throw new Error('Supported documents are PDF, DOCX, XLSX, text, CSV, JSON and XML.');
		const charset = /charset\s*=\s*["']?([\w-]+)/i;
		const declared =
			contentType.match(charset)?.[1] ??
			(mime === 'text/html'
				? Buffer.from(bytes.subarray(0, 1024))
						.toString('latin1')
						.match(/<meta\b[^>]*>/gi)
						?.map((tag) => tag.match(charset)?.[1])
						.find((value) => value !== undefined)
				: undefined);
		const body = new TextDecoder(declared ?? 'utf-8', { fatal: true }).decode(bytes);
		if (body.includes('\u0000')) throw new Error('Document contains binary data.');
		if (bytes.byteLength > 2 * 1024 * 1024)
			throw new Error('Document text exceeds the 2 MiB limit.');
		return { body, sha256 };
	}
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	const worker = new Worker(
		new URL(
			`./${office ? 'office' : 'pdf'}-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
			import.meta.url
		),
		{
			workerData: office ? { bytes, mime } : bytes,
			resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 }
		}
	);
	let onAbort: () => void = () => {};
	try {
		const result = await new Promise<unknown>((resolve, reject) => {
			onAbort = () => reject(bounded.reason);
			bounded.addEventListener('abort', onAbort, { once: true });
			worker.once('message', resolve);
			worker.once('error', reject);
			worker.once('exit', () =>
				reject(new Error('Document extraction ended without a complete result.'))
			);
			if (bounded.aborted) onAbort();
		});
		return { ...Schema.decodeUnknownSync(DocumentText)(result), sha256 };
	} finally {
		bounded.removeEventListener('abort', onAbort);
		await worker.terminate();
	}
}
