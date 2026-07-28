/** Sleep for `ms`, resolving early (never rejecting) if `signal` aborts. Isomorphic. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
