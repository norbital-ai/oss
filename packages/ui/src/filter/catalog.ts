// Readable catalogue paths, relation scopes and the host's offered conditions.
import type { ModelExposure } from '../kinds/context.js';
import type { RawArg } from './node.js';
import type { Kind } from '../kinds/kind.js';

export type Catalog = { readonly [model: string]: ModelExposure };

/** Saved rules may use readable machine fields that normal tables hide from their field picker. */
export function savedFilterCatalog(catalog: Catalog): Catalog {
	return Object.fromEntries(
		Object.entries(catalog).map(([model, exposure]) => [
			model,
			{
				...exposure,
				fields: Object.fromEntries(
					Object.entries(exposure.fields).map(([name, field]) => {
						const { hidden: _hidden, ...visible } = field;
						return [name, visible];
					})
				)
			}
		])
	);
}

/** A model's search index (`$search`: every word) and embedding (`$similar`: nearest in meaning) as condition keys. */
export const INDEX: { readonly [key: string]: { op: 'search' | 'similar'; label: string } } = {
	$search: { op: 'search', label: 'Search' },
	$similar: { op: 'similar', label: 'Topic' }
};

// ── the engine's condition catalogue (rule 16b): the builder renders exactly these, never a second operator table ──
/** One step of an offered condition's nesting from the model root (bolt's `FilterStep`, structurally). */
export type FilterStep =
	| { k: 'field'; name: string }
	| { k: 'is'; rel: string }
	| { k: 'arm'; rel: string; arm: string }
	| { k: 'some' | 'every' | 'none'; rel: string }
	| { k: 'count'; rel: string }
	| { k: 'agg'; rel: string; fn: 'sum' | 'avg' | 'min' | 'max'; of: string };

/** One offered (field, operator) pair as the host's `filter.options` returns it. */
export type Offer = {
	label: string;
	path: readonly FilterStep[];
	op: string;
	opLabel: string;
	kind: string;
	values?: readonly { label: string; arg: RawArg }[];
	sort?: string;
};

const stepName = (s: FilterStep): string =>
	s.k === 'field' ? s.name : s.k === 'arm' ? `${s.rel}:${s.arm}` : s.rel;

/** Whether two steps are the same: a field's name, an arc's relation and arm, a relation's kind and name. */
const sameStep = (a: FilterStep, b: FilterStep): boolean =>
	a.k === 'field' || b.k === 'field'
		? a.k === 'field' && b.k === 'field' && a.name === b.name
		: a.k === 'arm' || b.k === 'arm'
			? a.k === 'arm' && b.k === 'arm' && a.rel === b.rel && a.arm === b.arm
			: a.k === b.k && a.rel === b.rel;

export const pathOf = (steps: readonly FilterStep[]): string => steps.map(stepName).join('.');

/** An offer's steps within a context (`prefix` steps from the root), or `null` when it belongs to another context. */
export function within(offer: Offer, prefix: readonly FilterStep[]): readonly FilterStep[] | null {
	if (offer.path.length < prefix.length) return null;
	return prefix.every((s, i) => offer.path[i] !== undefined && sameStep(s, offer.path[i]))
		? offer.path.slice(prefix.length)
		: null;
}

/** The catalogue paths a picker offers in a context: offered condition paths, and the many-relations to expand. */
export function offeredPaths(
	offers: readonly Offer[],
	prefix: readonly FilterStep[]
): { conditions: Set<string>; many: Set<string> } {
	const conditions = new Set<string>(),
		many = new Set<string>();
	for (const o of offers) {
		const rest = within(o, prefix);
		const first = rest?.[0];
		if (first === undefined) continue;
		if (first.k === 'some' || first.k === 'every' || first.k === 'none') many.add(first.rel);
		else if (first.k === 'count' || first.k === 'agg') many.add(first.rel);
		else conditions.add(pathOf(rest ?? []));
	}
	return { conditions, many };
}

/** The offers for one condition path in a context: its operators, labels, values and literal kind. */
export function offersFor(
	offers: readonly Offer[],
	prefix: readonly FilterStep[],
	path: string
): readonly Offer[] {
	return offers.filter((o) => {
		const rest = within(o, prefix);
		return (
			rest !== null &&
			(rest.at(-1)?.k === 'field' || rest.at(-1)?.k === 'is' || rest.at(-1)?.k === 'arm') &&
			pathOf(rest) === path
		);
	});
}

/** What a many-relation offers in a context: its count and aggregate comparisons, and the aggregate child fields. */
export function manyOffers(
	offers: readonly Offer[],
	at: readonly FilterStep[],
	path: string
): { all: boolean; count: readonly Offer[]; aggs: readonly Offer[] } {
	const { prefix, name: rel } = manyAt(at, path);
	const count: Offer[] = [],
		aggs: Offer[] = [];
	let all = false;
	for (const o of offers) {
		const rest = within(o, prefix);
		const [first, second] = [rest?.[0], rest?.[1]];
		if (first === undefined) continue;
		if ((first.k === 'some' || first.k === 'every' || first.k === 'none') && first.rel === rel)
			all = true;
		else if (first.k === 'count' && first.rel === rel) count.push(o);
		else if (first.k === 'agg' && first.rel === rel && second === undefined) aggs.push(o);
	}
	return { all, count, aggs };
}

/** A many-relation's child model: the one whose relation to its owner declares it as `inverse`; `rel` may be
 * reached through one-relations (`customer.invoices`). */
export function childOf(cat: Catalog, model: string, rel: string): string | undefined {
	const steps = rel.split('.'),
		name = steps.pop() ?? '';
	const owner = steps.reduce<string | undefined>(
		(c, s) => (c === undefined ? undefined : cat[c]?.relations?.[s]?.targets[0]),
		model
	);
	if (owner === undefined || !(cat[owner]?.many ?? []).includes(name)) return undefined;
	return Object.keys(cat).find((c) =>
		Object.values(cat[c]?.relations ?? {}).some(
			(r) => r.inverse === name && r.targets.includes(owner)
		)
	);
}

/** The catalogue steps to a many-relation row's own options: the one-relations it is reached through, then itself. */
export const manyAt = (
	prefix: readonly FilterStep[],
	rel: string
): { prefix: FilterStep[]; name: string } => {
	const steps = rel.split('.'),
		name = steps.pop() ?? '';
	return { prefix: [...prefix, ...steps.map((r) => ({ k: 'is' as const, rel: r }))], name };
};

// ── the field tree ──
/** What a path ends on: a field of a kind, or a one-relation (a record condition). */
export type Resolved =
	| { leaf: 'field'; kind: Kind; nullable: boolean; label: string }
	| { leaf: 'rel'; targets: readonly string[]; nullable: boolean; label: string };

const RESERVED = new Set(['and', 'or', 'not']);

/** Fields a viewer may filter on: readable in its output, not hidden (rule 16a narrowing). */
export const filterable = (x: ModelExposure, f: string) =>
	!RESERVED.has(f) && x.fields[f] !== undefined && !x.fields[f]?.hidden;

const SYS: { readonly [f: string]: Kind } = {
	created_at: { kind: 'instant' },
	updated_at: { kind: 'instant' }
};

export function resolve(cat: Catalog, model: string, path: string): Resolved | null {
	const steps = path.split('.');
	let c = model;
	for (let i = 0; i < steps.length; i++) {
		const x = cat[c];
		if (x === undefined) return null;
		const [name = '', arm] = (steps[i] ?? '').split(':');
		const rel = x.relations?.[name];
		const last = i === steps.length - 1;
		if (rel !== undefined) {
			const targets = arm === undefined ? rel.targets : rel.targets.includes(arm) ? [arm] : [];
			if (targets.length === 0 || (rel.targets.length > 1 && arm === undefined)) return null; // an arc is named by its arm
			if (last)
				return { leaf: 'rel', targets, nullable: rel.optional === true, label: rel.label ?? name };
			if (i >= 2) return null; // two hops, as today's builder
			const target = targets[0];
			if (target === undefined) return null;
			c = target;
			continue;
		}
		if (!last || arm !== undefined) return null;
		if (INDEX[name] !== undefined)
			return (name === '$search' ? (x.search?.length ?? 0) > 0 : x.semantic === true)
				? {
						leaf: 'field',
						kind: { kind: 'text' },
						nullable: false,
						label: INDEX[name]?.label ?? name
					}
				: null;
		const kind =
			(c.startsWith('$') ? undefined : SYS[name]) ??
			(filterable(x, name) ? x.fields[name] : undefined); // `$local`: no system columns
		return kind === undefined
			? null
			: { leaf: 'field', kind, nullable: kind.optional === true, label: kind.label ?? name };
	}
	return null;
}
