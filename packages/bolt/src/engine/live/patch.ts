import { Predicate } from 'effect';
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
/**
 * One lane batch's work on a view: its value so far, the ops (each at its container's path) that made it, and how many
 * bytes they add to the value's JSON (negative: fewer). Only the rows and values the ops add or take away are measured.
 */
export type PatchWork = { value: Json; readonly ops: PatchOp[]; bytes: number };
type Patched = { value: Json; ops: PatchOp[]; bytes: number };
const utf8 = new TextEncoder();
const size = (value: Json): number => utf8.encode(JSON.stringify(value)).byteLength;
type Page = { readonly [key: string]: Json; readonly rows: readonly ViewRow[] };
const object = (value: Json | undefined): value is { readonly [key: string]: Json } => Predicate.isObject(value) && !Array.isArray(value);
const list = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
/** A retained page, as it is (no copy: its rows stay shared): records in `rows`, and `next` a cursor or none. */
const isPage = (value: Json | undefined): value is Page => {
	if (!object(value)) return false;
	const rows = value['rows'], next = value['next'];
	return list(rows) && rows.every(object) && (next === undefined || next === null || typeof next === 'string');
};
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
	const retained = plan.kind === 'get' ? object(value) ? value : undefined :
		isPage(value) ? value.rows.find((row) => row['id'] === c.id) : undefined;
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

function metadata(value: Json, path: readonly string[], c: Captured, field: Metadata): Patched | undefined {
	if (!object(value) || c.new === null) return undefined;
	const before = c.old === null ? {} : field.project(c.old), after = field.project(c.new);
	let answer = value,
		bytes = 0;
	const ops: PatchOp[] = [];
	for (const key of field.keys) {
		const previous = answer[key], next = after[key];
		if (same(previous, next)) continue;
		if (!same(previous, before[key])) return undefined;
		// an object member is `"key":value`, with a comma between two
		if (next !== undefined) {
			bytes += previous === undefined
				? size(key) + 1 + size(next) + (Object.keys(answer).length > 0 ? 1 : 0)
				: size(next) - size(previous);
			answer = { ...answer, [key]: next };
			ops.push({ op: 'meta', path, key, value: next });
		} else if (previous !== undefined) {
			const { [key]: _removed, ...rest } = answer;
			bytes -= size(key) + 1 + size(previous) + (Object.keys(rest).length > 0 ? 1 : 0);
			answer = rest;
			ops.push({ op: 'unset', path, key });
		}
	}
	return { value: answer, ops, bytes };
}

function rows(
	plan: Leaf,
	value: Json,
	path: readonly string[],
	id: string,
	c: Captured,
	row: ViewRow | null,
	before: ViewRow | null | undefined,
	bindings: Bindings
): Patched | undefined {
	if (plan.kind === 'get') {
		if (same(value, row)) return { value, ops: [], bytes: 0 };
		if (before !== undefined && !same(value, before)) return undefined;
		return {
			value: row,
			ops: row === null ? [{ op: 'remove', path, id }] : [{ op: 'upsert', path, index: 0, row }],
			bytes: size(row) - size(value)
		};
	}
	if (!isPage(value)) return undefined;
	const items = [...value.rows], i = items.findIndex((item) => item['id'] === id), previous = items[i];
	// an unchanged projection stays put while its own order keys hold (a moved relation it does not carry may reorder it);
	// a related model's commit that could reorder it invalidates the view in `resolve`
	if (previous !== undefined && row !== null && same(previous, row) && (c.model !== plan.model || plan.kept(previous, row, c)))
		return { value, ops: [], bytes: 0 };
	if (previous !== undefined && before !== undefined && !same(previous, row) && (before === null || !same(previous, before))) return undefined;
	let answer = value,
		bytes = 0;
	const ops: PatchOp[] = [];
	// `rows` holds each row's JSON, with a comma between two
	const insert = (at: number, added: ViewRow) => {
		bytes += size(added) + (items.length > 0 ? 1 : 0);
		items.splice(at, 0, added);
	};
	const remove = (gone: ViewRow, at: number) => {
		items.splice(at, 1);
		bytes -= size(gone) + (items.length > 0 ? 1 : 0);
	};
	if (c.model === plan.model)
		for (const counter of plan.counters) {
			const current = answer[counter.key];
			if (typeof current !== 'number') return undefined;
			const old = c.old === null ? false : counter.includes(c.old, bindings), next = c.new === null ? false : counter.includes(c.new, bindings);
			if (old === undefined || next === undefined) return undefined;
			const count = current + Number(next) - Number(old);
			if (count < 0) return undefined;
			if (count !== current) {
				bytes += size(count) - size(current);
				answer = { ...answer, [counter.key]: count };
				ops.push({ op: 'meta', path, key: counter.key, value: count });
			}
		}
	const more = value['next'] != null || (plan.bounded && items.length >= plan.limit);
	answer = { ...answer, rows: items };
	if (row === null) {
		if (previous === undefined) return { value: answer, ops, bytes };
		if (more) return undefined;
		remove(previous, i);
		return { value: answer, ops: [...ops, { op: 'remove', path, id }], bytes };
	}
	if (previous !== undefined && plan.kept(previous, row, c)) {
		if (!same(previous, row)) {
			items[i] = row;
			bytes += size(row) - size(previous);
			ops.push({ op: 'upsert', path, index: i, row });
		}
		return { value: answer, ops, bytes };
	}
	if (plan.bounded && more && i >= 0) return undefined;
	const last = items.at(-1)?.['id'];
	if (previous !== undefined) remove(previous, i);
	const index = plan.place(items, row);
	if (index === undefined) return undefined;
	if (plan.bounded) {
		if (index >= plan.limit) return { value: answer, ops, bytes };
		insert(index, row);
		ops.push({ op: 'upsert', path, index, row });
		const overflow = items.length > plan.limit ? items.at(-1) : undefined;
		if (overflow !== undefined) {
			const removed = overflow['id'];
			if (typeof removed !== 'string') return undefined;
			remove(overflow, items.length - 1);
			ops.push({ op: 'remove', path, id: removed });
		}
		return { value: answer, ops, bytes };
	}
	if (more) {
		if (index === items.length) return i < 0 ? { value: answer, ops, bytes } : undefined;
		if (i < 0) return undefined;
		insert(index, row);
		return items.at(-1)?.['id'] === last ? { value: answer, ops: [...ops, { op: 'upsert', path, index, row }], bytes } : undefined;
	}
	if (items.length + 1 > plan.limit) return undefined;
	insert(index, row);
	return { value: answer, ops: [...ops, { op: 'upsert', path, index, row }], bytes };
}

/** Apply one resolved leaf change immutably at its container's path, sharing every container it leaves alone. */
export function apply(work: PatchWork, change: Resolved, row: ViewRow | null | undefined, bindings: Bindings, snapshots: Snapshots): boolean {
	if (baselineContains(change.plan, change.c, snapshots)) return true;
	const value = at(work.value, change.path);
	if (value === undefined) return false;
	const patched = 'metadata' in change ? metadata(value, change.path, change.c, change.metadata) : row === undefined ? undefined :
		rows(change.plan, value, change.path, change.id, change.c, row, 'before' in change ? change.before : undefined, bindings);
	if (patched === undefined) return false;
	if (patched.ops.length === 0) return true;
	const next = replace(work.value, change.path, 0, patched.value);
	if (next === undefined) return false;
	work.value = next;
	work.ops.push(...patched.ops);
	work.bytes += patched.bytes;
	return true;
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
