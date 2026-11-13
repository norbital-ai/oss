// Operator admission, literal kinds and operand choices for filter editing.
import type { Kind } from '../kinds/kind.js';
import { type Resolved, type Offer, type FilterStep, INDEX, offersFor, type Catalog, resolve } from './catalog.js';
import { type Op, OpSchema, type Arg } from './node.js';
import { Match, Schema } from 'effect';
import { type VarResult, compile_var, member_admits } from '@norbital-ai/store/vars';

/** The kind a condition's literal is edited and checked as: state → its states, derived numbers → numbers. */
export function valueKind(k: Kind): Kind {
	if (k.kind === 'state') return { kind: 'enum', values: Object.keys(k.states) };
	if ((k.kind === 'text' || k.kind === 'enum') && k.many) {
		const { many: _, ...scalar } = k;
		return scalar;
	}
	if (k.kind === 'seq') return k.pattern === undefined ? { kind: 'int' } : { kind: 'text' };
	if (k.kind === 'sum' || k.kind === 'count' || k.kind === 'money') return { kind: 'number' };
	return k;
}

/** The kind a condition's literal is for `op`: a period's day for "in force on", a JSON document as itself, else
 * `valueKind`. */
export const litKind = (r: Extract<Resolved, { leaf: 'field' }>, op: Op): Kind =>
	op === 'contains' && r.kind.kind === 'period'
		? { kind: r.kind.of }
		: op === 'contains' && r.kind.kind === 'json'
			? r.kind
			: valueKind(r.kind);

/** An operator's own words (bolt's), where the catalogue has none. */
export const OP_LABEL: { readonly [op in Op]: string } = {
	eq: 'is',
	ne: 'is not',
	lt: 'less than',
	lte: 'at most',
	gt: 'more than',
	gte: 'at least',
	in: 'is any of',
	not_in: 'is none of',
	like: 'contains',
	is_null: 'is empty',
	not_null: 'is not empty',
	has: 'has',
	has_any: 'has any of',
	has_all: 'has all of',
	is_empty: 'is empty',
	not_empty: 'is not empty',
	during: 'is within',
	contains: 'contains',
	overlaps: 'overlaps',
	contained_by: 'is within',
	starts_within: 'starts within',
	ends_within: 'ends within',
	near: 'is within',
	search: 'matches',
	similar: 'is about'
};

const DATE_WORDS: { readonly [op in Op]?: string } = {
	gt: 'after',
	gte: 'on or after',
	lt: 'before',
	lte: 'on or before',
	contains: 'in force on'
};

/** An operator's fallback words on a resolved path: a date's or period's own ("after", "in force on"), else bolt's. */
export const opWord = (op: Op, r: Resolved | null): string =>
	(r?.leaf === 'field' && ['date', 'instant', 'period'].includes(r.kind.kind)
		? DATE_WORDS[op]
		: undefined) ?? OP_LABEL[op];

const CMP_OPS: readonly Op[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];

const EQUALITY_OPS: readonly Op[] = ['eq', 'ne', 'in', 'not_in'];

/** The grammar's operators for a path by its kind (`during` needs the catalogue's spans, so it waits for them). */
function kindOps(r: Resolved): readonly Op[] {
	const nulls: readonly Op[] = r.nullable ? ['is_null', 'not_null'] : [];
	if (r.leaf === 'rel') return [...EQUALITY_OPS, ...nulls];
	const k = r.kind;
	if ((k.kind === 'text' || k.kind === 'enum') && k.many)
		return ['has', 'has_any', 'has_all', 'is_empty', 'not_empty'];
	if (k.kind === 'seq') return [...EQUALITY_OPS, ...nulls];
	const own: readonly Op[] = Match.value(k.kind).pipe(
		Match.when('text', (): readonly Op[] => ['like', ...EQUALITY_OPS]),
		Match.whenOr('enum', 'state', 'ref', 'currency', (): readonly Op[] => EQUALITY_OPS),
		Match.when('bool', (): readonly Op[] => ['eq']),
		Match.whenOr('int', 'decimal', 'money', 'number', 'count', 'sum', (): readonly Op[] => [
			...CMP_OPS,
			'in',
			'not_in'
		]),
		Match.whenOr('time', 'date', 'instant', (): readonly Op[] => CMP_OPS),
		Match.when('period', (): readonly Op[] => [
			'contains',
			'overlaps',
			'contained_by',
			'starts_within',
			'ends_within'
		]),
		Match.when('json', (): readonly Op[] => ['contains']),
		Match.orElse((): readonly Op[] => [])
	);
	return [...own, ...nulls];
}

/** Every operator a condition may lower to: its kind's, plus a date's span and a described point's radius. */
export function grammarOps(r: Resolved): readonly Op[] {
	const own = kindOps(r);
	if (r.leaf === 'rel') return own;
	const kind = r.kind.kind;
	return [
		...own,
		...(kind === 'date' || kind === 'instant' ? (['during'] as const) : []),
		...(kind === 'point' ? (['near'] as const) : [])
	];
}

/** The operators a condition on `path` offers: the catalogue's; else (still loading, or a path the catalogue does not
 * walk) its kind's scalar operators. A described near or date span is never invented by the fallback. */
export function operatorsFor(
	offers: readonly Offer[],
	prefix: readonly FilterStep[],
	path: string,
	r: Resolved
): readonly { op: Op; label: string }[] {
	const index = INDEX[path.split('.').at(-1) ?? ''];
	const allowed: readonly Op[] = index !== undefined ? [index.op] : grammarOps(r);
	const offered = offersFor(offers, prefix, path).flatMap((o) =>
		Schema.is(OpSchema)(o.op) && allowed.includes(o.op) ? [{ op: o.op, label: o.opLabel }] : []
	);
	if (offered.length > 0)
		return offered.filter((o, i) => offered.findIndex((x) => x.op === o.op) === i);
	return (index === undefined ? kindOps(r) : [index.op]).map((op) => ({
		op,
		label: opWord(op, r)
	}));
}

/** The kind of value a variable must produce in a value position, or `null` where none is taken. */
function varResult(r: Resolved, op: Op): VarResult | null {
	if (op === 'in' || op === 'not_in') return 'list';
	if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains'].includes(op)) return null;
	if (r.leaf === 'rel') return op === 'eq' || op === 'ne' ? 'text' : null;
	if (op === 'contains' && r.kind.kind !== 'period') return null;
	const k = r.kind.kind === 'period' ? (r.kind.of === 'date' ? 'date' : 'instant') : r.kind.kind;
	return k === 'date' ? 'date' : k === 'instant' ? 'instant' : 'text';
}

/** The field a variable's requestor members are admitted against (store's vars `member_admits`). */
const varField = (r: Resolved) =>
	r.leaf === 'rel'
		? { kind: 'id', of: r.targets[0] }
		: {
				kind: r.kind.kind,
				email: r.kind.kind === 'text' && r.kind.format === 'email',
				phone: r.kind.kind === 'text' && r.kind.format === 'phone',
				team: r.kind.kind === 'text' && r.kind.format === 'team'
			};

/** A rule-owned expression scope for a saved filter. The owner checks and resolves these variables before querying;
 * ordinary toolbar filters continue to use the requestor and clock scope. */
export type FilterVariables = {
	readonly presets: readonly string[];
	validate(text: string, position: Resolved, op: Op): string | undefined;
};

const VARIABLE_OPS: readonly Op[] = [
	'like',
	'eq',
	'ne',
	'lt',
	'lte',
	'gt',
	'gte',
	'in',
	'not_in',
	'has',
	'has_any',
	'has_all',
	'contains',
	'overlaps',
	'contained_by',
	'starts_within',
	'ends_within'
];

/** Why `text` is not a variable this position takes, or `undefined` when it is. An instant position takes a date too
 * (that day's midnight in the workspace zone). */
export function varError(
	r: Resolved,
	op: Op,
	text: string,
	variables?: FilterVariables
): string | undefined {
	if (variables !== undefined)
		return VARIABLE_OPS.includes(op)
			? variables.validate(text, r, op)
			: 'this condition takes no variable';
	const want = varResult(r, op);
	if (want === null) return 'this condition takes no variable';
	let c = compile_var(text, want);
	if ('error' in c && want === 'instant') {
		const day = compile_var(text, 'date');
		if (!('error' in day)) c = day;
	}
	if ('error' in c) return c.error;
	const f = varField(r);
	const refused = c.requestor.find((m) => !member_admits(f, m));
	return refused === undefined
		? undefined
		: `requestor.${refused} does not compare with this field`;
}

/** The `@` presets a value position offers: requestor members and clock expressions its kind admits. */
const PRESETS = [
	'requestor.id',
	'requestor.email',
	'requestor.phone',
	'requestor.party',
	'requestor.teams',
	'requestor.team_tree',
	'today',
	'today - days(7)',
	'start_of_week(today)',
	'start_of_month(today)',
	'now',
	'now - hours(1)'
];

export const variablesFor = (
	r: Resolved,
	op: Op,
	variables?: FilterVariables
): readonly { name: string; arg: Arg }[] =>
	// the requestor's id names a member record: offered on a link, though a ported text column may compare with it
	(variables?.presets ?? PRESETS)
		.filter(
			(text) =>
				varError(r, op, text, variables) === undefined &&
				(text !== 'requestor.id' || r.leaf === 'rel')
		)
		.map((text) => ({
			name: variableName(text),
			arg: { _tag: 'var', var: text }
		}));

/** A variable's chip text: `requestor` for the requestor's id, else the expression itself. */
export const variableName = (text: string): string => (text === 'requestor.id' ? 'requestor' : text);

/** The variable a value is (`requestor`, `today - days(7)`), or `undefined` for a literal or another operand. */
export const variableOf = (arg: Arg | null): string | undefined =>
	arg !== null && arg._tag === 'var' ? variableName(arg.var) : undefined;

/** The operand choices of a value position: a literal, a variable, a same-row field. */
export function operandsFor(
	r: Resolved,
	op: Op,
	variables?: FilterVariables
): ('lit' | 'var' | 'field')[] {
	return [
		'lit',
		...((variables === undefined ? variablesFor(r, op).length > 0 : VARIABLE_OPS.includes(op))
			? ['var' as const]
			: []),
		...(r.leaf === 'field' && ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(op)
			? ['field' as const]
			: [])
	];
}

/** The same-row fields a `{ field }` operand at `path` may name: the same kind, beside it on its model. */
export function fieldsFor(cat: Catalog, model: string, path: string): readonly string[] {
	if (path.includes('.')) return [];
	const r = resolve(cat, model, path);
	if (r === null || r.leaf !== 'field') return [];
	const kind = valueKind(r.kind).kind;
	return Object.keys(cat[model]?.fields ?? {}).filter((f) => {
		if (f === path) return false;
		const o = resolve(cat, model, f);
		return o !== null && o.leaf === 'field' && valueKind(o.kind).kind === kind;
	});
}

export const argKind = (arg: Arg | null): 'lit' | 'list' | 'range' | 'var' | 'field' =>
	arg === null ? 'lit' : arg._tag;
