import { formatValue as show, currencyOf, minorDigits, shownKind } from '../kinds/kind.js';
import type { Kind } from '../kinds/kind.js';
import { Decimal } from '@norbital-ai/std/decimal';
import type { Values } from '../model/types.js';
import { isMasked, valueAt } from '../cell/value.js';
import { refOf } from '../relations/select.js';
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Excel reads a CSV as UTF-8 (Chinese included) only behind this byte-order mark. */
export const CSV_BOM = '\uFEFF';
/** One CSV cell: relation labels, enum words, ISO dates, and exact decimal or currency scale; the rest as shown. */
export function csvCell(
	row: Values,
	f: string,
	kind: Kind | undefined,
	words: (value: string) => string,
	locale = 'en'
): string {
	const ref = refOf(row, f);
	if (ref !== undefined) return ref.text;
	const v = valueAt(row, f);
	const numericKind = kind === undefined ? undefined : shownKind(kind);
	if (
		v !== undefined &&
		v !== null &&
		!isMasked(v) &&
		(numericKind?.kind === 'decimal' || numericKind?.kind === 'money')
	) {
		const currency = numericKind.kind === 'money' ? currencyOf(numericKind, row) : undefined;
		const scale =
			numericKind.kind === 'decimal'
				? numericKind.scale
				: (numericKind.scale ?? (currency === undefined ? 2 : minorDigits(currency)));
		return Decimal.of(String(v)).round(scale).toString();
	}
	if (kind?.kind === 'enum' || kind?.kind === 'state')
		return (Array.isArray(v) ? v : [v])
			.filter((x) => x !== null)
			.map((x) => words(String(x)))
			.join(', ');
	if (
		typeof v === 'string' &&
		(kind?.kind === 'date' || kind?.kind === 'instant' || INSTANT.test(v))
	)
		return v;
	return show(valueAt(row, f), locale);
}
