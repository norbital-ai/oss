import { Worker } from 'node:worker_threads';
import type { Finding } from './index.js';
import type { TypeAwareRun } from './type-aware.js';

type AuthoredRun = Readonly<{
	packs: ReadonlyArray<string>;
	findings: ReadonlyArray<Finding>;
	ruleCount: number;
	ruleSetDigest: string;
	allFiles: ReadonlyArray<string>;
	selectedFiles: ReadonlyArray<string>;
	/** Coverage of the type-aware tier, which always runs. Findings are already merged above. */
	typeAware: Omit<TypeAwareRun, 'findings'>;
}>;

type AuthoredRequest = Readonly<{
	root: string;
	includeTests: boolean;
	paths: ReadonlyArray<string>;
	signal?: AbortSignal | undefined;
}>;

type AuthoredWorkerResult = Readonly<{
	readonly type: 'authored-result';
	readonly result: AuthoredRun;
}>;

/**
 * Load and execute repository-authored rules in a fresh module graph.
 *
 * Vite keeps this package alive for the whole dev server. A normal dynamic import would cache a
 * config's transitive rule modules forever, so editing an imported rule would appear to do nothing.
 * A short-lived worker gives every audit a fresh ESM cache while returning only durable data.
 */
export function runAuthored(request: AuthoredRequest): Promise<AuthoredRun> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./authored-worker.js', import.meta.url), {
			workerData: {
				root: request.root,
				includeTests: request.includeTests,
				paths: request.paths
			}
		});
		const abort = () => {
			void worker.terminate();
			reject(request.signal?.reason ?? new Error('norbital-doctor: authored-rule scan aborted'));
		};
		if (request.signal?.aborted) {
			abort();
			return;
		}
		request.signal?.addEventListener('abort', abort, { once: true });
		worker.on('message', (message: unknown) => {
			const completed = message as Partial<AuthoredWorkerResult>;
			if (completed.type !== 'authored-result' || completed.result === undefined) return;
			request.signal?.removeEventListener('abort', abort);
			resolve(completed.result);
			void worker.terminate();
		});
		worker.once('error', (error) => {
			request.signal?.removeEventListener('abort', abort);
			reject(error);
		});
		worker.once('exit', (code) => {
			if (code !== 0)
				reject(new Error(`norbital-doctor: authored-rule worker stopped with exit code ${code}`));
		});
	});
}
