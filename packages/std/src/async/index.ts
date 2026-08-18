import { Effect } from 'effect';

function createAbortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Runs the effect while honoring an external `AbortSignal`: when the signal
 * aborts, the effect's fiber is interrupted and the effect fails with the
 * abort reason. When the effect completes first, the signal listener is
 * removed. When no signal is provided the effect runs as-is, relying on
 * Effect's own interruption.
 */
export const withAbortableOperation = <T>(
	effect: Effect.Effect<T>,
	options?: { signal?: AbortSignal; onAbort?: (error: Error) => void }
): Effect.Effect<T> => {
	const { signal, onAbort } = options ?? {};
	if (!signal) return effect;

	const abortEffect = Effect.promise<never>((effectSignal) =>
		new Promise<never>((_resolve, reject) => {
			const handleAbort = () => {
				effectSignal.removeEventListener('abort', handleAbort);
				signal.removeEventListener('abort', handleAbort);
				// The effect's own signal aborts when this promise-based effect is
				// interrupted — that is the race being lost, not the external abort.
				if (effectSignal.aborted) return;
				const abortError = createAbortError(signal);
				onAbort?.(abortError);
				reject(abortError);
			};
			if (signal.aborted) {
				handleAbort();
				return;
			}
			effectSignal.addEventListener('abort', handleAbort, { once: true });
			signal.addEventListener('abort', handleAbort, { once: true });
		})
	);

	return Effect.raceFirst(effect, abortEffect);
};
