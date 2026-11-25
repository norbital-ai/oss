import { Predicate } from 'effect';
import { format_value as show, type EnumScope } from '../kinds/kind.js';
import { flat } from '../read/aggregate.js';
import type { SourceRows } from '../read/source.js';

const numeric = (raw: unknown): number | null => {
	if (raw === null || raw === undefined) return null;
	const value =
		Predicate.isObject(raw) && 'amount' in raw ? Number(String(raw.amount)) : Number(String(raw));
	return Number.isFinite(value) ? value : null;
};

/**
 * Chart data: rows (read, query or aggregate) as flat records, `x` as text, each `y` a number. With a model's `scope`, a
 * category the catalog names (an enum or state value) reads as its label.
 */
export function series(
	v: SourceRows,
	x: string,
	y: readonly string[],
	scope: EnumScope = {}
): { [k: string]: string | number | null }[] {
	const named = (raw: string): string | undefined => {
		if (scope.t === undefined || !scope.model || !scope.field) return undefined;
		const key = `models.${scope.model}.fields.${scope.field}.${raw}`;
		const text = scope.t(key);
		return text === key ? undefined : text;
	};
	return ('rows' in v ? v.rows : v).map(flat).map((r) => ({
		[x]: (typeof r[x] === 'string' ? named(r[x]) : undefined) ?? show(r[x] ?? null),
		...Object.fromEntries(y.map((k) => [k, numeric(r[k])]))
	}));
}
