/**
 * Server-side helpers shared by the collection roles that speak in payroll months.
 *
 * `controller-surfaces.md` §1 tells app and representation authors to inline duplicated one-liners
 * rather than grow the import graph. It scopes that to controller UI; these are `+hooks.ts` and
 * `+pipelines.ts` code, where a copy that drifts changes what the server *accepts*, not how a cell
 * reads. The scanner had already caught each of these as an identical body in two roles.
 */

/**
 * The first and last calendar day of a `YYYY-MM` month.
 *
 * `Date.UTC(year, index, 0)` is day zero of the *next* month, i.e. the last day of this one, so
 * February resolves to 28 or 29 without a leap-year branch. The month index is one-based here
 * precisely because it is being passed as the next month.
 */
export function monthBounds(month: string): { readonly start: string; readonly end: string } {
	const [year, index] = month.split('-').map(Number) as [number, number];
	const start = `${month}-01`;
	const lastDay = new Date(Date.UTC(year, index, 0)).getUTCDate();
	return { start, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * A bulleted refusal listing, truncated so a failed import of twenty thousand rows does not answer
 * with twenty thousand lines.
 */
export function formatNamedList(items: readonly string[], limit = 20): string {
	const shown = items.slice(0, limit);
	const lines = shown.map((item) => `• ${item}`);
	const remainder = items.length > limit ? `\n…and ${items.length - limit} more.` : '';
	return `${lines.join('\n')}${remainder}`;
}
