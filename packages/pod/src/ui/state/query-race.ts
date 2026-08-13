type LocalRace<T> =
	| { readonly status: 'value'; readonly value: T }
	| { readonly status: 'empty' };

type ServerRace<T> =
	| { readonly status: 'value'; readonly value: T }
	| { readonly status: 'error'; readonly error: unknown };

/**
 * Start from an already-in-flight server promise. If a local replica read returns a real
 * value first, use it; otherwise use the server answer and absorb it. Never wait for a
 * slow local path before the server request exists — the caller must create `server` first.
 */
export async function raceLocalAndServer<T>(
	server: Promise<T>,
	local: () => Promise<T | null | undefined>,
	absorb?: (value: T) => void
): Promise<T> {
	const localAttempt: Promise<LocalRace<T>> = Promise.resolve()
		.then(() => local())
		.then((value) =>
			value !== null && value !== undefined
				? { status: 'value' as const, value }
				: { status: 'empty' as const }
		)
		.catch(() => ({ status: 'empty' as const }));

	const serverAttempt: Promise<ServerRace<T>> = server.then(
		(value) => ({ status: 'value' as const, value }),
		(error: unknown) => ({ status: 'error' as const, error })
	);

	const first = await Promise.race([
		localAttempt.then((result) => ({ source: 'local' as const, result })),
		serverAttempt.then((result) => ({ source: 'server' as const, result }))
	]);

	if (first.source === 'local' && first.result.status === 'value') {
		void serverAttempt.then((result) => {
			if (result.status === 'value') absorb?.(result.value);
		});
		return first.result.value;
	}

	const serverResult = first.source === 'server' ? first.result : await serverAttempt;
	if (serverResult.status === 'value') {
		absorb?.(serverResult.value);
		return serverResult.value;
	}
	throw serverResult.error;
}
