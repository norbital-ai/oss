// The draft a structured `sys_2.infer` builds, addressed by keyed pointers: RFC 6901 JSON Pointers whose segment for an
// item of a keyed list (`{ kind: 'list', key }`) is that item's key, not its index, so removing one item never moves
// another's path. Pure (types only), so `jsonDiff` serves guests as well as the engine's `diff` tool.
import type { Kind } from '@norbital-ai/std/kind';
import type { InputKind } from '../../decl/fields.ts';
import type { Json } from '../../decl/values.ts';

/** One difference between two JSON values, at a keyed pointer. */
export type JsonChange = {
	readonly path: string;
	readonly kind: 'added' | 'removed' | 'changed';
	readonly before?: Json;
	readonly after?: Json;
};
/** The kind of a part nothing declares: any JSON, unkeyed. */
export const ANY: Kind = { kind: 'json' };
type Obj = { readonly [key: string]: Json };
export const isObj = (v: Json | undefined): v is Obj =>
	v !== null && typeof v === 'object' && !Array.isArray(v);
export const isList = (v: Json | undefined): v is readonly Json[] => Array.isArray(v);

/** A keyed list's key: the field of its object items that names each one. */
export const keyOf = (k: Kind): string | undefined =>
	k.kind === 'list' && 'key' in k && typeof k.key === 'string' ? k.key : undefined;
/** An item's key as a pointer segment; absent unless a non-empty text or a number. */
export const keyText = (item: Json | undefined, key: string): string | undefined => {
	const v = isObj(item) ? item[key] : undefined;
	return typeof v === 'number' ? String(v) : typeof v === 'string' && v !== '' ? v : undefined;
};
/** The kind of child `seg` of a value of kind `k` (a tagged union's arm is read from `holder`); absent when it has none. */
export function childKind(k: Kind, seg: string, holder: Json | undefined): Kind | undefined {
	switch (k.kind) {
		case 'list':
		case 'record':
			return k.of;
		case 'object':
			return k.fields[seg] ?? k.rest;
		case 'json':
			return k.shape === undefined ? ANY : childKind(k.shape, seg, holder);
		case 'union': {
			if ('of' in k) return undefined;
			if (seg === k.by) return { kind: 'enum', values: Object.keys(k.arms) };
			const tag = isObj(holder) ? holder[k.by] : undefined;
			return typeof tag === 'string' ? k.arms[tag]?.[seg] : ANY;
		}
		default:
			return ANY;
	}
}

/** A pointer's segments, `~1` and `~0` unescaped; absent when it is neither "" nor starts with "/". */
export const segments = (path: string): readonly string[] | undefined =>
	path === ''
		? []
		: path.startsWith('/')
			? path
					.slice(1)
					.split('/')
					.map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))
			: undefined;
export const pointer = (segs: readonly string[]): string =>
	segs.map((s) => `/${s.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
/** The index of the list item `seg` names: by key in a keyed list, else as a number; -1 when none. */
export const indexOf = (list: readonly Json[], seg: string, key: string | undefined): number => {
	if (key !== undefined) return list.findIndex((item) => keyText(item, key) === seg);
	const n = /^(0|[1-9]\d*)$/.test(seg) ? Number(seg) : -1;
	return n < list.length ? n : -1;
};

/** The value at keyed pointer `path` in `doc` and its kind, or what is missing. */
export function resolve(doc: Json, path: string, kind: Kind): { value: Json; kind: Kind } | string {
	const segs = segments(path);
	if (segs === undefined) return `${path}: a path is "" or starts with "/"`;
	let value = doc,
		k = kind;
	for (const [i, seg] of segs.entries()) {
		const next = isList(value)
			? value[indexOf(value, seg, keyOf(k))]
			: isObj(value) && Object.hasOwn(value, seg)
				? value[seg]
				: undefined;
		if (next === undefined) return `${pointer(segs.slice(0, i + 1))}: nothing is there`;
		k = childKind(k, seg, value) ?? ANY;
		value = next;
	}
	return { value, kind: k };
}

/** A decode problem's dotted path (list items by index) as a keyed pointer into `value`. */
export function keyedPath(value: Json, kind: Kind, dotted: readonly string[]): string {
	const out: string[] = [];
	let v: Json | undefined = value,
		k: Kind = kind;
	for (const seg of dotted) {
		const key = keyOf(k);
		out.push((key !== undefined && isList(v) ? keyText(v[Number(seg)], key) : undefined) ?? seg);
		const holder = v;
		v = isList(v) ? v[Number(seg)] : isObj(v) ? v[seg] : undefined;
		k = childKind(k, seg, holder) ?? ANY;
	}
	return pointer(out);
}

/** `value` narrowed to `fields`: an object to those fields, each object item of a list to its key and those fields. */
export function project(value: Json, kind: Kind, fields: readonly string[]): Json {
	const key = keyOf(kind);
	const pick = (v: Json): Json =>
		isObj(v)
			? Object.fromEntries(Object.entries(v).filter(([f]) => f === key || fields.includes(f)))
			: v;
	return isList(value) ? value.map(pick) : pick(value);
}

/** Text and number leaves, and field names, under `value` (at `path`) that hold `text`, case-insensitively. */
export function find(
	value: Json,
	kind: Kind,
	path: string,
	text: string
): { path: string; excerpt: string }[] {
	const needle = text.toLowerCase();
	const hits: { path: string; excerpt: string }[] = [];
	const walk = (v: Json, k: Kind, at: string): void => {
		if (isList(v)) {
			const key = keyOf(k),
				of = childKind(k, '', v) ?? ANY;
			v.forEach((x, i) =>
				walk(
					x,
					of,
					`${at}${pointer([(key === undefined ? undefined : keyText(x, key)) ?? String(i)])}`
				)
			);
		} else if (isObj(v))
			for (const [f, x] of Object.entries(v)) {
				const p = `${at}${pointer([f])}`;
				if (f.toLowerCase().includes(needle)) hits.push({ path: p, excerpt: f });
				walk(x, childKind(k, f, v) ?? ANY, p);
			}
		else if (typeof v === 'string' || typeof v === 'number') {
			const s = String(v),
				i = s.toLowerCase().indexOf(needle);
			if (i >= 0)
				hits.push({
					path: at,
					excerpt:
						s.length <= 80
							? s
							: `${i > 20 ? '…' : ''}${s.slice(Math.max(0, i - 20), i + 60)}${i + 60 < s.length ? '…' : ''}`
				});
		}
	};
	walk(value, kind, path);
	return hits;
}

/** The changes from `before` to `after` under `path`, appended to `out`; keyed list items matched by key. */
export function diffAt(
	before: Json | undefined,
	after: Json | undefined,
	kind: Kind,
	path: string,
	out: JsonChange[]
): void {
	if (before === undefined) {
		if (after !== undefined) out.push({ path, kind: 'added', after });
		return;
	}
	if (after === undefined) {
		out.push({ path, kind: 'removed', before });
		return;
	}
	if (isList(before) && isList(after)) {
		const key = keyOf(kind),
			of = childKind(kind, '', before) ?? ANY;
		if (key !== undefined) {
			const index = (xs: readonly Json[]) =>
				new Map(
					xs.flatMap((x) => {
						const t = keyText(x, key);
						return t === undefined ? [] : [[t, x] as const];
					})
				);
			const was = index(before),
				is = index(after);
			// a keyless or repeated key falls back to matching by index
			if (was.size === before.length && is.size === after.length) {
				for (const [t, x] of was) diffAt(x, is.get(t), of, `${path}${pointer([t])}`, out);
				for (const [t, x] of is)
					if (!was.has(t)) out.push({ path: `${path}${pointer([t])}`, kind: 'added', after: x });
				return;
			}
		}
		for (let i = 0; i < Math.max(before.length, after.length); i++)
			diffAt(before[i], after[i], of, `${path}/${i}`, out);
		return;
	}
	if (isObj(before) && isObj(after)) {
		for (const f of new Set([...Object.keys(before), ...Object.keys(after)]))
			diffAt(before[f], after[f], childKind(kind, f, after) ?? ANY, `${path}${pointer([f])}`, out);
		return;
	}
	if (JSON.stringify(before) !== JSON.stringify(after))
		out.push({ path, kind: 'changed', before, after });
}

/**
 * What changed from `before` to `after`, each change at a JSON Pointer: added, removed or changed (leaves only; an added
 * or removed object or item is one change). With `output`, items of its keyed lists are matched and addressed by key, so
 * a removal is one change rather than a shift of every later item; other lists are compared by index.
 */
export function jsonDiff(before: Json, after: Json, output?: InputKind): readonly JsonChange[] {
	const out: JsonChange[] = [];
	diffAt(before, after, output ?? ANY, '', out);
	return out;
}
