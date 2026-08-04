/**
 * Coercions from a raw `<input>` string to the value a custom-type renderer emits.
 *
 * These are shared rather than inlined per renderer, which is the opposite of the default in
 * `controller-surfaces.md` §1. The exception is deliberate: §1 forbids one-liner *presentation*
 * helpers (`human-label.ts`, options builders) whose only cost is an import, and its stated reason
 * is that duplication is cheaper than another import graph. These are not presentation — they are
 * the write path. Fifteen copies of "is this string a finite number, and what does blank mean" is
 * fifteen places for the blank-versus-zero answer to drift, and the scanner had already caught
 * eight of them as identical bodies.
 *
 * `selectKind` stays inlined in each renderer: it closes over that file's `current`, `emit` and
 * `defaultFor`, so sharing it would mean threading three callbacks through a generic — §2's
 * "thinner than a real component, keep it inlined".
 */

/** A finite number from a raw field, or `fallback` when the field does not hold one. */
export function numberFrom(raw: string, fallback: number): number {
	const next = Number(raw);
	return Number.isFinite(next) ? next : fallback;
}

/** As `numberFrom`, where an empty field means "no bound" rather than a value. */
export function nullableNumberFrom(raw: string): number | null {
	if (raw.trim().length === 0) return null;
	const next = Number(raw);
	return Number.isFinite(next) ? next : null;
}

/** A comma-separated field as a list, with blanks and surrounding space dropped. */
export function splitList(raw: string): string[] {
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}
