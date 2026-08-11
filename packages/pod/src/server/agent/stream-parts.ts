/** Decide when transient provider deltas have become a useful durable text part. */
export function shouldPersistStreamPart(input: {
	readonly pending: string;
	readonly elapsedMs: number;
}): boolean {
	if (input.pending.length >= 240) return true;
	if (input.pending.length < 32) return false;
	if (/\n\s*$/.test(input.pending)) return true;
	if (/[.!?][\s”'\"]*$/.test(input.pending)) return true;
	return input.pending.length >= 64 && input.elapsedMs >= 400;
}
