// Filter and sort words, labels and styled sentence parts.
import { type Catalog, INDEX, type Resolved, childOf, resolve } from './catalog.js';
import type { SortKey } from './order.js';
import { type Quant, type Op, varOf, type Arg, type Node, OpSchema } from './node.js';
import type { Value } from '@norbital-ai/std/kind';
import { litKind, variableName, opWord } from './operators.js';
import { format, type Json, isPoint } from '../kinds/kind.js';
import { Match, Schema } from 'effect';

/** A radius as words: "500 m", "1.5 km". */
export const radiusText = (m: number) =>
	m >= 1000 ? `${Math.round(m / 100) / 10} km` : `${Math.round(m)} m`;

const pointText = (p: { lat: number; lng: number }) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;

/** A sort key in words: "Site › Location nearest to 1.3291, 103.7690", or the field's own label. */
export const sortText = (cat: Catalog, model: string, k: SortKey, human: (s: string) => string) =>
	k.near === undefined
		? pathLabel(cat, model, k.field, human)
		: `${pathLabel(cat, model, k.field, human)} nearest to ${pointText(k.near)}`;

// ── labels (English fallbacks; the view passes them through `msg`) ──
export const QUANT_LABEL: { readonly [q in Quant]: string } = {
	some: 'has any',
	none: 'has none',
	every: 'all match',
	count: 'count',
	sum: 'sum of',
	min: 'min of',
	max: 'max of',
	avg: 'average of'
};

/** "Account › Owner › Name": each step's declared label, else its humanized name. */
export function pathLabel(
	cat: Catalog,
	model: string,
	path: string,
	human: (s: string) => string
): string {
	const out: string[] = [];
	let c = model;
	for (const step of path.split('.')) {
		const [name = '', arm] = step.split(':');
		const x = cat[c],
			rel = x?.relations?.[name];
		// a relation is named for its record ("Site"), never its key column ("Site id"): the describer's own words
		out.push(
			(INDEX[name]?.label ??
				rel?.label ??
				x?.fields[name]?.label ??
				human(rel === undefined ? name : name.replace(/_id$/, ''))) +
				(arm === undefined ? '' : ` (${human(arm)})`)
		);
		c = arm ?? rel?.targets[0] ?? c;
	}
	return out.join(' › ');
}

/** One piece of a row's words, by what it names, so a chip styles field, operator and value apart. */
export type Part = { readonly text: string; readonly role: 'field' | 'op' | 'value' | 'join' };

/** Whether a space goes before part `i` (none inside parentheses). */
export const spaced = (parts: readonly Part[], i: number): boolean =>
	i > 0 && parts[i]?.text !== ')' && parts[i - 1]?.text !== '(';

export const partsText = (parts: readonly Part[]): string =>
	parts.map((p, i) => (spaced(parts, i) ? ` ${p.text}` : p.text)).join('');

const part = (role: Part['role'], text: string): Part[] => (text === '' ? [] : [{ role, text }]);

/** Parts joined by a word (`and`, `or`). */
const joined = (groups: readonly (readonly Part[])[], word: string): Part[] =>
	groups.flatMap((g, i) => (i === 0 ? [...g] : [...part('join', word), ...g]));

/** How a row's values read: a related record by its label, every literal through its kind's formatter. */
type Words = {
	human: (s: string) => string;
	ref: ((target: string, id: string) => string) | undefined;
	op: (op: string, path: string, r?: Resolved | null) => string;
	locale: string;
};

const yesNo = (v: Value) => (v === true ? 'yes' : v === false ? 'no' : String(v));

function litText(r: Resolved | null, op: Op, v: Value, w: Words): string {
	if (r === null) return String(v);
	if (r.leaf === 'rel')
		return typeof v === 'string' && w.ref !== undefined ? w.ref(r.targets[0] ?? '', v) : String(v);
	const k = litKind(r, op);
	return k.kind === 'bool' ? yesNo(v) : format(k, v, { locale: w.locale }) || String(v);
}

function boundText(r: Resolved | null, v: Json, w: Words): string {
	const text = varOf(v);
	if (text !== null) return `@${variableName(text)}`;
	return r?.leaf === 'field' && (r.kind.kind === 'date' || r.kind.kind === 'instant')
		? format({ kind: r.kind.kind }, v, { locale: w.locale }) || String(v)
		: String(v);
}

function argText(cat: Catalog, model: string, r: Resolved | null, op: Op, arg: Arg, w: Words) {
	return Match.value(arg).pipe(
		Match.tagsExhaustive({
			lit: (value) => litText(r, op, value.lit, w),
			list: (value) => value.list.map((v) => litText(r, op, v, w)).join(', '),
			range: (value) =>
				value.label ?? `${boundText(r, value.range[0], w)} – ${boundText(r, value.range[1], w)}`,
			var: (value) => `@${variableName(value.var)}`,
			field: (value) => pathLabel(cat, model, value.field, w.human)
		})
	);
}

function partsOf(cat: Catalog, model: string, n: Node, w: Words): Part[] {
	if (n.t === 'group') {
		const inner = joined(
			n.of.map((x) => partsOf(cat, model, x, w)),
			n.join
		);
		const wrapped =
			n.not || n.of.length > 1 ? [...part('join', '('), ...inner, ...part('join', ')')] : inner;
		return n.not ? [...part('join', 'not'), ...wrapped] : wrapped;
	}
	const head = part('field', pathLabel(cat, model, n.t === 'many' ? n.rel : n.path, w.human));
	if (n.t === 'many') {
		const child = childOf(cat, model, n.rel) ?? '';
		if (n.q === 'some' || n.q === 'none' || n.q === 'every')
			return [
				...head,
				...part('op', `${QUANT_LABEL[n.q]}${n.of.length > 0 ? ':' : ''}`),
				...joined(
					n.of.map((x) => partsOf(cat, child, x, w)),
					'and'
				)
			];
		return [
			...head,
			...part('op', QUANT_LABEL[n.q]),
			...part('field', n.field === undefined ? '' : pathLabel(cat, child, n.field, w.human)),
			...part('op', w.op(n.op ?? 'eq', n.rel)),
			...part(
				'value',
				n.n === undefined || n.n === null
					? ''
					: format(
							n.field === undefined
								? { kind: 'number' }
								: (cat[child]?.fields[n.field] ?? { kind: 'number' }),
							n.n,
							{ locale: w.locale }
						)
			)
		];
	}
	if (n.op === 'near' && n.arg !== null && 'lit' in n.arg && Array.isArray(n.arg.lit)) {
		const [p, m] = n.arg.lit;
		if (!isPoint(p ?? null) || typeof m !== 'number') return head;
		return [
			...head,
			...part('op', 'within'),
			...part('value', `${radiusText(m)} of ${pointText(p)}`)
		];
	}
	const r = resolve(cat, model, n.path);
	return [
		...head,
		...part('op', w.op(n.op, n.path, r)),
		...part('value', n.arg === null ? '' : argText(cat, model, r, n.op, n.arg, w))
	];
}

/** A row's words as parts: the author's read-only scope and a viewer row's chip. `ref` names a relation's record (its
 * label, never its id); `opLabel` names the operator (the catalogue's words, when the caller has them; a caller's machine
 * fallback reads as the operator's own words). Values format by their kind in `locale`. */
export function nodeParts(
	cat: Catalog,
	model: string,
	n: Node,
	human: (s: string) => string,
	ref?: (target: string, id: string) => string,
	opLabel?: (op: string, path: string) => string,
	locale = 'en'
): Part[] {
	const op = (o: string, path: string, r: Resolved | null = null) => {
		const said = opLabel?.(o, path);
		return said !== undefined && said !== o ? said : Schema.is(OpSchema)(o) ? opWord(o, r) : o;
	};
	return partsOf(cat, model, n, { human, ref, op, locale });
}

/** One line for a row: `nodeParts` as text. */
export const nodeText = (...args: Parameters<typeof nodeParts>): string =>
	partsText(nodeParts(...args));
