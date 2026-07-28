export { batchOperation, itemsSource, paginatedSource } from './batch.js';
export type {
	BatchCollectFn,
	BatchContext,
	BatchOperationFlatOptions,
	BatchOperationMapOptions,
	BatchOperationOptions,
	BatchOperationReduceOptions,
	BatchOperationResult,
	BatchRunFn,
	BatchSource,
	BatchSourceItem,
	ItemsBatchSource,
	PaginatedBatchSource
} from './batch.js';

export type SettledResult<T> = {
	fulfilled: T[];
	rejected: unknown[];
};

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout<T>(
	fn: () => Promise<T>,
	timeoutMs: number,
	label?: string
): Promise<T> {
	const signal = AbortSignal.timeout(timeoutMs);

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			const msg = label ? `${label} exceeded ${timeoutMs}ms` : `Operation exceeded ${timeoutMs}ms`;
			reject(new Error(msg));
		};
		signal.addEventListener('abort', onAbort, { once: true });

		fn().then(
			(result) => {
				signal.removeEventListener('abort', onAbort);
				resolve(result);
			},
			(error) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			}
		);
	});
}

export async function allSettled<T>(promises: Array<Promise<T>>): Promise<SettledResult<T>> {
	const settled = await Promise.allSettled(promises);
	const fulfilled: T[] = [];
	const rejected: unknown[] = [];

	for (const result of settled) {
		if (result.status === 'fulfilled') {
			fulfilled.push(result.value);
		} else {
			rejected.push(result.reason);
		}
	}

	return { fulfilled, rejected };
}

function createAbortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	return new DOMException('The operation was aborted.', 'AbortError');
}

export function withAbortableOperation<T>(
	operation: () => Promise<T>,
	options?: { signal?: AbortSignal; onAbort?: (error: Error) => void }
): Promise<T> {
	const { signal, onAbort } = options ?? {};
	signal?.throwIfAborted();
	if (!signal) return operation();

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finalize = () => {
			signal.removeEventListener('abort', handleAbort);
		};
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			finalize();
			callback();
		};
		const handleAbort = () => {
			const abortError = createAbortError(signal);
			onAbort?.(abortError);
			settle(() => reject(abortError));
		};
		signal.addEventListener('abort', handleAbort, { once: true });
		operation().then(
			(result) => {
				settle(() => resolve(result));
			},
			(error) => {
				settle(() => reject(error));
			}
		);
	});
}
