import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { Schema } from 'effect';

const PdfText = Schema.Struct({ body: Schema.NonEmptyString, pageCount: Schema.Natural });

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
	if (mime !== 'application/pdf') {
		if (!/^(text\/[\w.+-]+|application\/(json|(?:[\w.-]+\+)?xml))$/.test(mime))
			throw new Error('Supported documents are PDF, UTF-8 text, JSON and XML.');
		const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		if (body.includes('\u0000')) throw new Error('Document contains binary data.');
		if (bytes.byteLength > 2 * 1024 * 1024)
			throw new Error('Document text exceeds the 2 MiB limit.');
		return { body, sha256 };
	}
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	const worker = new Worker(
		new URL(
			import.meta.url.endsWith('.ts') ? './pdf-worker.ts' : './pdf-worker.js',
			import.meta.url
		),
		{ workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } }
	);
	let onAbort: () => void = () => {};
	try {
		const result = await new Promise<unknown>((resolve, reject) => {
			onAbort = () => reject(bounded.reason);
			bounded.addEventListener('abort', onAbort, { once: true });
			worker.once('message', resolve);
			worker.once('error', reject);
			worker.once('exit', () =>
				reject(new Error('PDF extraction ended without a complete result.'))
			);
			if (bounded.aborted) onAbort();
		});
		return { ...Schema.decodeUnknownSync(PdfText)(result), sha256 };
	} finally {
		bounded.removeEventListener('abort', onAbort);
		await worker.terminate();
	}
}
