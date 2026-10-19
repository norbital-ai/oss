import type { ViewBolt } from '../client/contract.js';
export const fill = (s: string, vars: { readonly [n: string]: string | number }) =>
	s.replace(/\{(\w+)\}/g, (m, n: string) => (vars[n] === undefined ? m : String(vars[n])));
/** The ui's own keys (`ui.*`) fall back to English outside a catalog. */
export function msg(
	bolt: Pick<ViewBolt, 't'>,
	key: string,
	fallback: string,
	vars: { readonly [n: string]: string | number } = {}
): string {
	const s = bolt.t(`ui.${key}`, vars);
	return s === `ui.${key}` ? fill(fallback, vars) : s;
}
export const humanize = (name: string) =>
	name
		.replace(/[_.]+/g, ' ')
		.trim()
		.replace(/^\w/, (c) => c.toUpperCase());
/**
 * A collection's or field's label: the catalog key, else the field's `declared` label, else the humanized name (final-ui
 * rule 32); a FK names its target (`project_id` → `Project`).
 */
export function label(
	bolt: Pick<ViewBolt, 't'>,
	collection: string,
	field?: string,
	declared?: string
): string {
	const key =
		field === undefined ? `models.${collection}.label` : `models.${collection}.fields.${field}`;
	const s = bolt.t(key);
	return s !== key ? s : (declared ?? humanize((field ?? collection).replace(/_id$/, '')));
}
/** A label inside a sentence: its first letter lowered unless it leads an acronym (`Jobs` → `jobs`, `SOW documents` stays). */
export const lowerLead = (s: string) =>
	/^\p{Lu}\p{Ll}/u.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
/** One record of a collection: the catalog's `models.<c>.singular`, else its label made singular (`Categories` → `Category`). */
export function singular(bolt: Pick<ViewBolt, 't'>, collection: string): string {
	const key = `models.${collection}.singular`,
		s = bolt.t(key);
	return s !== key
		? s
		: label(bolt, collection)
				.replace(/ies$/, 'y')
				.replace(/(ss|x|ch|sh)es$/, '$1')
				.replace(/([^su])s$/, '$1');
}
