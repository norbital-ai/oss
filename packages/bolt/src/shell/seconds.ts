/** One-second browser ticker; the caller owns its start instant and returned teardown. */
export function everySecond(update: (at: number) => void): () => void {
	const timer = setInterval(() => update(Date.now()), 1_000);
	return () => clearInterval(timer);
}
