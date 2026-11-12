import { Option, Predicate, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { PatchOp } from '../../protocol/wire.ts';
import type { Bindings, Captured, RowData } from '../contracts.ts';
import { same, type GetView, type Metadata, type ReadView, type RowFetch, type ViewPlan, type ViewRow } from '../query/view.ts';
import { visibleIn, type ReadSnapshot } from '../query/snapshot.ts';

type Leaf = GetView | ReadView;
type Change = { readonly plan: Leaf; readonly path: readonly string[]; readonly c: Captured; readonly id: string };
export type Resolved =
	| (Change & { readonly row: ViewRow | null; readonly before: ViewRow | null | undefined })
	| (Change & { readonly get: RowFetch })
	| { readonly plan: ReadView; readonly path: readonly string[]; readonly c: Captured; readonly metadata: Metadata };
export type Snapshots = ReadonlyMap<string, ReadSnapshot>;
export type PatchWork = { value: Json; readonly ops: PatchOp[]; readonly roots: Set<string> };
const Page = Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)), next: Schema.optionalKey(Schema.NullOr(Schema.String)) });
const pageOf = Schema.decodeUnknownOption(Page);
const object = (value: Json | undefined): value is { readonly [key: string]: Json } => Predicate.isObject(value) && !Array.isArray(value);
const at = (value: Json, path: readonly string[]): Json | undefined => {
	let current: Json | undefined = value;
	for (const key of path) {
		if (!object(current) || !Object.hasOwn(current, key)) return undefined;
		current = current[key];
	}
	return current;
};
function replace(value: Json, path: readonly string[], depth: number, answer: Json): Json | undefined {
	if (depth === path.length) return answer;
	const key = path[depth];
	if (key === undefined || !object(value)) return undefined;
	const child = value[key];
	if (child === undefined) return undefined;
	const next = replace(child, path, depth + 1, answer);
	return next === undefined ? undefined : { ...value, [key]: next };
}
const baselineContains = (plan: Leaf, c: Captured, snapshots: Snapshots): boolean => {
	const snapshot = snapshots.get(plan.key);
	return plan.kind === 'read' && plan.counters.length > 0 && c.model === plan.model &&
		snapshot !== undefined && visibleIn(c.transaction, snapshot);
};

/** Resolve one real capture against a compiled get/read/request graph. Undefined means a real read is needed. */
export function resolve(
	plan: ViewPlan,
	value: Json,
	c: Captured,
	bindings: Bindings,
	snapshots: Snapshots,
	path: readonly string[] = []
): readonly Resolved[] | undefined {
	if (!plan.models.has(c.model)) return [];
	if (plan.kind === 'request') {
		if (plan.target?.model === c.model && plan.target.id !== c.id) return [];
		if (plan.roots === undefined || !object(value)) return undefined;
		const out: Resolved[] = [];
		for (const root of plan.roots) {
			const child = value[root.key];
			if (child === undefined) return undefined;
			const changes = resolve(root.plan, child, c, bindings, snapshots, [...path, root.key]);
			if (changes === undefined) return undefined;
			out.push(...changes);
		}
		return out;
	}
	if (baselineContains(plan, c, snapshots)) return [];
	if (plan.invalidates?.(c)) return undefined;
	if (c.model !== plan.model) {
		if (plan.kind === 'read') {
			const metadata = plan.metadata.find((field) => field.model === c.model && field.id === c.id);
			if (metadata !== undefined) return c.new === null ? undefined : [{ plan, path, c, metadata }];
		}
		const ids = plan.related?.(c, value) ?? 'all';
		if (plan.kind === 'get') return ids === 'all' || ids.includes(plan.id) ? undefined : [];
		const fetch = plan.fetch;
		if (ids === 'all' || fetch === undefined) return ids !== 'all' && ids.length === 0 ? [] : undefined;
		return ids.map((id) => ({ plan, path, c, id, get: fetch(id) }));
	}
	if (plan.kind === 'get' && c.id !== plan.id) return [];
	if (plan.kind === 'read' && plan.counters.length > 0 && snapshots.get(plan.key) === undefined) return undefined;
	if (plan.kind === 'read' && plan.counters.some((counter) =>
		(c.old !== null && counter.includes(c.old, bindings) === undefined) ||
		(c.new !== null && counter.includes(c.new, bindings) === undefined))) return undefined;
	const page = plan.kind === 'read' ? pageOf(value) : undefined;
	const retained = plan.kind === 'get' ? object(value) ? value : undefined :
		page !== undefined && Option.isSome(page) ? page.value.rows.find((row) => row['id'] === c.id) : undefined;
	const project = (image: RowData | null): ViewRow | null | undefined => {
		if (image === null) return null;
		const matches = plan.matches(image, bindings);
		return matches === false ? null : matches === undefined ? undefined : plan.project(image, bindings, retained);
	};
	const before = project(c.old), row = project(c.new);
	if (before === null && row === null && (plan.kind === 'get' || plan.counters.length === 0)) return [];
	if (row === undefined) {
		if (plan.fetch === undefined) return undefined;
		return [{ plan, path, c, id: c.id, get: plan.fetch(c.id) }];
	}
	return [{ plan, path, c, id: c.id, row, before }];
}

function metadata(value: Json, c: Captured, field: Metadata): { value: Json; ops: PatchOp[] } | undefined {
	if (!object(value) || c.new === null) return undefined;
	const before = c.old === null ? {} : field.project(c.old), after = field.project(c.new);
	let answer = value;
	const ops: PatchOp[] = [];
	for (const key of field.keys) {
		const previous = answer[key], next = after[key];
		if (same(previous, next)) continue;
		if (!same(previous, before[key])) return undefined;
		if (next === undefined) {
			const { [key]: _removed, ...rest } = answer;
			answer = rest;
			ops.push({ op: 'unset', key });
		} else {
			answer = { ...answer, [key]: next };
			ops.push({ op: 'meta', key, value: next });
		}
	}
	return { value: answer, ops };
}

function rows(
	plan: Leaf,
	value: Json,
	id: string,
	c: Captured,
	row: ViewRow | null,
	before: ViewRow | null | undefined,
	bindings: Bindings
): { value: Json; ops: PatchOp[] } | undefined {
	if (plan.kind === 'get') {
		if (same(value, row)) return { value, ops: [] };
		if (before !== undefined && !same(value, before)) return undefined;
		return { value: row, ops: row === null ? [{ op: 'remove', id }] : [{ op: 'upsert', index: 0, row }] };
	}
	const decoded = pageOf(value);
	if (Option.isNone(decoded) || !object(value)) return undefined;
	const items = [...decoded.value.rows], i = items.findIndex((item) => item['id'] === id), previous = items[i];
	// an unchanged projection stays put while its own order keys hold (a moved relation it does not carry may reorder it);
	// a related model's commit that could reorder it invalidates the view in `resolve`
	if (previous !== undefined && row !== null && same(previous, row) && (c.model !== plan.model || plan.kept(previous, row, c)))
		return { value, ops: [] };
	if (previous !== undefined && before !== undefined && !same(previous, row) && (before === null || !same(previous, before))) return undefined;
	let answer = value;
	const ops: PatchOp[] = [];
	if (c.model === plan.model)
		for (const counter of plan.counters) {
			const current = answer[counter.key];
			if (typeof current !== 'number') return undefined;
			const old = c.old === null ? false : counter.includes(c.old, bindings), next = c.new === null ? false : counter.includes(c.new, bindings);
			if (old === undefined || next === undefined) return undefined;
			const count = current + Number(next) - Number(old);
			if (count < 0) return undefined;
			if (count !== current) { answer = { ...answer, [counter.key]: count }; ops.push({ op: 'meta', key: counter.key, value: count }); }
		}
	const more = decoded.value.next != null || (plan.bounded && items.length >= plan.limit);
	answer = { ...answer, rows: items };
	if (row === null) {
		if (i < 0) return { value: answer, ops };
		if (more) return undefined;
		items.splice(i, 1);
		return { value: answer, ops: [...ops, { op: 'remove', id }] };
	}
	if (previous !== undefined && plan.kept(previous, row, c)) {
		if (!same(previous, row)) { items[i] = row; ops.push({ op: 'upsert', index: i, row }); }
		return { value: answer, ops };
	}
	if (plan.bounded && more && i >= 0) return undefined;
	const last = items.at(-1)?.['id'];
	if (i >= 0) items.splice(i, 1);
	const index = plan.place(items, row);
	if (index === undefined) return undefined;
	if (plan.bounded) {
		if (index >= plan.limit) return { value: answer, ops };
		items.splice(index, 0, row);
		ops.push({ op: 'upsert', index, row });
		if (items.length > plan.limit) {
			const removed = items.pop()?.['id'];
			if (typeof removed !== 'string') return undefined;
			ops.push({ op: 'remove', id: removed });
		}
		return { value: answer, ops };
	}
	if (more) {
		if (index === items.length) return i < 0 ? { value: answer, ops } : undefined;
		if (i < 0) return undefined;
		items.splice(index, 0, row);
		return items.at(-1)?.['id'] === last ? { value: answer, ops: [...ops, { op: 'upsert', index, row }] } : undefined;
	}
	if (items.length + 1 > plan.limit) return undefined;
	items.splice(index, 0, row);
	return { value: answer, ops: [...ops, { op: 'upsert', index, row }] };
}

/** Apply resolved leaf changes immutably; named request roots are emitted once after the whole lane batch. */
export function apply(work: PatchWork, change: Resolved, row: ViewRow | null | undefined, bindings: Bindings, snapshots: Snapshots): boolean {
	if (baselineContains(change.plan, change.c, snapshots)) return true;
	const value = at(work.value, change.path);
	if (value === undefined) return false;
	const patched = 'metadata' in change ? metadata(value, change.c, change.metadata) : row === undefined ? undefined :
		rows(change.plan, value, change.id, change.c, row, 'before' in change ? change.before : undefined, bindings);
	if (patched === undefined) return false;
	if (patched.ops.length === 0) return true;
	const next = replace(work.value, change.path, 0, patched.value);
	if (next === undefined) return false;
	work.value = next;
	const root = change.path[0];
	if (root === undefined) work.ops.push(...patched.ops);
	else work.roots.add(root);
	return true;
}
export function patches(work: PatchWork): readonly PatchOp[] {
	const roots: PatchOp[] = [];
	for (const key of work.roots) {
		const value = object(work.value) ? work.value[key] : undefined;
		if (value !== undefined) roots.push({ op: 'meta', key, value });
	}
	return [...work.ops, ...roots];
}
export function arrivals(plan: ViewPlan, c: Captured): readonly Json[] {
	if (!plan.models.has(c.model) || c.op !== 'create' || c.new === null) return [];
	if (plan.kind === 'request') return plan.roots?.flatMap((root) => arrivals(root.plan, c)) ?? [];
	if (plan.kind !== 'read' || c.model !== plan.model) return [];
	const row = plan.arrivals?.(c.new);
	return row === undefined ? [] : [row];
}
export function keys(plan: ViewPlan): readonly string[] {
	return [plan.key, ...(plan.kind === 'request' ? plan.roots?.flatMap((root) => keys(root.plan)) ?? [] : [])];
}
