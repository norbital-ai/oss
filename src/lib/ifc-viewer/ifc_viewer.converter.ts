import converterWorkerUrl from './ifc_viewer.converter.worker.ts?worker&url';

type WorkerSuccessMessage = {
	type: 'success';
	fragmentBytes: ArrayBuffer;
};

type WorkerErrorMessage = {
	type: 'error';
	error: string;
};

type WorkerReadyMessage = {
	type: 'ready';
};

type WorkerResponseMessage = WorkerSuccessMessage | WorkerErrorMessage | WorkerReadyMessage;

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

async function createConverterWorker(): Promise<Worker> {
	const workerUrl = new URL(converterWorkerUrl, import.meta.url);
	// Sandboxed iframes block direct worker URLs in Chrome.
	// Fetch the script and create a blob URL to bypass the restriction.
	const response = await fetch(workerUrl.href);
	const scriptText = await response.text();
	const blob = new Blob([scriptText], { type: 'application/javascript' });
	const blobUrl = URL.createObjectURL(blob);
	return new Worker(blobUrl, { name: 'norbital-ifc-converter' });
}

function getTransferBuffer(bytes: Uint8Array): ArrayBuffer {
	if (
		bytes.buffer instanceof ArrayBuffer &&
		bytes.byteOffset === 0 &&
		bytes.byteLength === bytes.buffer.byteLength
	) {
		return bytes.buffer;
	}

	return bytes.slice().buffer;
}

export async function convertIfcToFragments(bytes: Uint8Array): Promise<Uint8Array> {
	const worker = await createConverterWorker();
	const transferBuffer = getTransferBuffer(bytes);

	return new Promise<Uint8Array>((resolve, reject) => {
		let settled = false;
		const settle = (complete: () => void): void => {
			if (settled) return;
			settled = true;
			worker.terminate();
			complete();
		};

		worker.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
			const message = event.data;
			if (message.type === 'ready') {
				return;
			}
			if (message.type === 'success') {
				settle(() => resolve(new Uint8Array(message.fragmentBytes)));
				return;
			}
			settle(() => reject(new Error(message.error)));
		};

		worker.onerror = (event: ErrorEvent) => {
			const details = [
				event.message,
				event.filename ? `file: ${event.filename}` : null,
				event.lineno ? `line: ${event.lineno}` : null,
				event.colno ? `col: ${event.colno}` : null
			]
				.filter(Boolean)
				.join(', ');

			const errorMessage = details || 'Unknown worker error';
			console.error('[IFCViewer] Converter worker error event:', {
				message: event.message,
				filename: event.filename,
				lineno: event.lineno,
				colno: event.colno,
				error: event.error
			});

			settle(() => reject(event.error instanceof Error ? event.error : new Error(errorMessage)));
		};

		worker.onmessageerror = (event: MessageEvent) => {
			console.error('[IFCViewer] Converter worker message error:', event);
			settle(() => reject(new Error('Unable to communicate with the IFC conversion worker.')));
		};

		try {
			worker.postMessage(
				{
					type: 'convert',
					bytes: transferBuffer
				},
				[transferBuffer]
			);
		} catch (error) {
			settle(() => reject(toError(error)));
		}
	});
}
