// Decode and flatten (rules 21–23a): an act's input (or a transform's payload) becomes a flat list of `Change`s, one per
// row, relation actions made explicit. Decode checks the collection's input allowlist at every nesting level and reports
// every offender at once; nothing is ever deleted by omission (rule 22).
import type { Json } from '../../decl/values.ts';
import type { Change, EngineActor, EngineManifest, InputPath, RowData } from '../contracts.ts';
import { LIMITS } from '../contracts.ts';
import type { Catalog, FieldInfo, ModelInfo } from '../../protocol/catalog.ts';
import { offsetMs } from '../query/eval.ts';
import { canonical } from './sql.ts';
import { decodeInput, type InputSpec } from '../callables/decode.ts';

/** An input allowlist (`SelectionBase`), or `'any'` for a transform payload: every stored field and relation action. */
export type Sel = 'any' | { readonly columns: readonly string[]; readonly with?: { readonly [rel: string]: { readonly [action: string]: unknown } } };
/** One flattened row change plus what the pipeline judges it by. */
export type Item = {
	change: Change;
	/** Fields the input supplied (rule 35: only these are admitted field by field; relation names included). */
	supplied: string[];
	/** Refs the input supplied (rule 36), `field → target`. */
	refs: { field: string; to: string; id: string }[];
	/** Set on a relation action: the parent row and the relation it came through. */
	parent?: { collection: string; id: string; rel: string; fk: string };
	/** `link`/`unlink`/nested `update`/`delete` name an existing child that must belong to (or be free for) the parent. */
	belongs?: 'parent' | 'free';
};
export type Problem = { path: InputPath; message: string };

type Obj = { readonly [k: string]: Json };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const ACTIONS = ['create', 'update', 'upsert', 'link', 'unlink', 'delete'] as const;

export class Flattener {
	readonly items: Item[] = [];
	readonly problems: Problem[] = [];
	private readonly m: EngineManifest;
	private readonly cat: Catalog;
	private readonly mint: () => string;
	constructor(m: EngineManifest, cat: Catalog, mint: () => string) {
		this.m = m; this.cat = cat; this.mint = mint;
	}

	private model(name: string): ModelInfo {
		return this.cat.models.get(name)!;
	}
	private bad(path: InputPath, message: string): void {
		this.problems.push({ path, message });
	}

	/** Decodes the columns of one input object; relation keys are returned for the caller to walk. */
	private columns(model: string, sel: Sel, value: unknown, path: InputPath): { values: Record<string, Json>; rels: [string, Obj][]; supplied: string[] } | null {
		if (!isObj(value)) { this.bad(path, 'expected an object'); return null; }
		const info = this.model(model);
		const values: Record<string, Json> = {}, rels: [string, Obj][] = [], supplied: string[] = [];
		for (const [k, v] of Object.entries(value)) {
			const at = [...path, k];
			const rel = info.many.get(k);
			if (rel !== undefined) {
				if (sel !== 'any' && sel.with?.[k] === undefined) this.bad(at, `'${k}' is not accepted here`);
				else if (!isObj(v)) this.bad(at, 'expected relation actions');
				else { rels.push([k, v]); supplied.push(k); }
				continue;
			}
			const f = info.fields.get(k);
			if (f === undefined || k.includes('.')) { this.bad(at, `'${k}' is not a field of ${model}`); continue; }
			if (f.computed || f.derived || SYSTEM.has(k)) { this.bad(at, `'${k}' is derived and cannot be written`); continue; }
			if (sel !== 'any' && !sel.columns.includes(k)) { this.bad(at, `'${k}' is not accepted here`); continue; }
			const problem = decodeValue(f, v, this.m.models[model]?.fields[k]);
			if (problem !== null) { this.bad(at, problem); continue; }
			values[k] = v;
			supplied.push(k);
		}
		return { values, rels, supplied };
	}
	private refsOf(model: string, values: Record<string, Json>): Item['refs'] {
		const info = this.model(model);
		return Object.entries(values).flatMap(([k, v]) => {
			const one = info.one.get(k);
			if (one === undefined) return [];
			// an exclusive arc names its arm (`RecordRef`, decoded against the arms)
			const ref = one.targets.length > 1 && isObj(v) ? v : undefined;
			return typeof v === 'string' ? [{ field: k, to: one.targets[0]!, id: v }]
				: ref !== undefined ? [{ field: k, to: String(ref['collection']), id: String(ref['id']) }] : [];
		});
	}
	private depth(path: InputPath): boolean {
		if (path.filter((p) => typeof p === 'string' && (ACTIONS as readonly string[]).includes(p)).length <= LIMITS.writeDepth) return true;
		this.bad(path, `relation actions nest at most ${LIMITS.writeDepth} deep`);
		return false;
	}

	create(model: string, sel: Sel, value: unknown, path: InputPath, parent?: Item['parent'], upsert?: { on: readonly string[]; onConflict: 'update' | 'keep' }, named?: string): void {
		const d = this.columns(model, sel, value, path);
		if (d === null) return;
		if (named !== undefined) d.values['id'] = named; // an upsert by id: resolution reads it, and it is never written
		// the parent key a relation action implies is not a caller-supplied ref (rule 36)
		const refs = this.refsOf(model, d.values);
		if (parent !== undefined) d.values[parent.fk] = parent.id;
		const id = this.mint();
		const change: Change = upsert === undefined ? { collection: model, id, path, op: 'create', values: d.values }
			: { collection: model, id, path, op: 'upsert', values: d.values, on: upsert.on, onConflict: upsert.onConflict };
		this.items.push({ change, supplied: d.supplied, refs, ...(parent === undefined ? {} : { parent }) });
		this.relations(model, sel, id, d.rels, path);
	}

	update(model: string, sel: Sel, id: unknown, set: unknown, revision: number | null, path: InputPath, parent?: Item['parent']): void {
		if (typeof id !== 'string') { this.bad([...path, 'target'], 'expected an id'); return; }
		const d = this.columns(model, sel, set, [...path, 'set']);
		if (d === null) return;
		this.items.push({ change: { collection: model, id, path, op: 'update', set: d.values, revision }, supplied: d.supplied,
			refs: this.refsOf(model, d.values), ...(parent === undefined ? {} : { parent, belongs: 'parent' as const }) });
		this.relations(model, sel, id, d.rels, [...path, 'set']);
	}

	delete(model: string, id: unknown, revision: number | null, path: InputPath, parent?: Item['parent']): void {
		if (typeof id !== 'string') { this.bad(path, 'expected an id'); return; }
		this.items.push({ change: { collection: model, id, path, op: 'delete', revision }, supplied: [], refs: [],
			...(parent === undefined ? {} : { parent, belongs: 'parent' as const }) });
	}

	/**
	 * A relation-action upsert (rule 28): the child row names its record by `id`: a row with an id updates that child (or,
	 * `{ values, onConflictDoUpdate: false }`, leaves it), a row without one is created. A bare values object (the
	 * transform payload's shape) updates.
	 */
	private upsert(model: string, sel: Sel, v: Json, path: InputPath, parent: Item['parent']): void {
		const wrapped = isObj(v) && 'values' in v && 'onConflictDoUpdate' in v;
		if (wrapped && (typeof v['onConflictDoUpdate'] !== 'boolean' || Object.keys(v).length !== 2)) { this.bad(path, 'expected { values, onConflictDoUpdate }'); return; }
		const at = wrapped ? [...path, 'values'] : path, row = wrapped ? v['values'] : v;
		if (!isObj(row)) { this.bad(at, 'expected an object'); return; }
		const { id, ...values } = row;
		if (id === undefined) { this.create(model, sel, values, at, parent); return; }
		if (typeof id !== 'string') { this.bad([...at, 'id'], 'expected an id'); return; }
		this.create(model, sel, values, at, parent, { on: ['id'], onConflict: wrapped && v['onConflictDoUpdate'] === false ? 'keep' : 'update' }, id);
	}

	/** Explicit relation actions (rule 22): each names its rows; an empty array or an omitted key does nothing. */
	private relations(model: string, sel: Sel, id: string, rels: [string, Obj][], path: InputPath): void {
		for (const [name, actions] of rels) {
			const rel = this.model(model).many.get(name)!;
			const spec = this.m.relationships[`${rel.child}.${rel.column}`];
			const parent = { collection: model, id, rel: name, fk: rel.column };
			const allowed = sel === 'any' ? undefined : sel.with?.[name];
			for (const [action, list] of Object.entries(actions)) {
				const at = [...path, name, action];
				if (!(ACTIONS as readonly string[]).includes(action) || (allowed !== undefined && allowed[action] === undefined)) { this.bad(at, `'${action}' is not accepted here`); continue; }
				if (!Array.isArray(list)) { this.bad(at, 'expected a list'); continue; }
				if (!this.depth(at)) continue;
				const sub: Sel = allowed === undefined ? 'any' : allowed[action] as Sel;
				list.forEach((v: Json, i: number) => {
					const p = [...at, i];
					if (action === 'create') this.create(rel.child, sub, v, p, parent);
					else if (action === 'upsert') this.upsert(rel.child, sub, v, p, parent);
					else if (action === 'update') isObj(v) ? this.update(rel.child, sub, v['target'], v['set'], null, p, parent) : this.bad(p, 'expected { target, set }');
					else if (action === 'delete') this.delete(rel.child, v, null, p, parent);
					else if (spec?.owned) this.bad(p, `an owned ${rel.child} never changes its parent`);
					else if (typeof v !== 'string') this.bad(p, 'expected an id');
					// link and unlink are FK updates of the child (rule 22); `unlink` of a required ref fails NOT NULL (`required`)
					else this.items.push({ change: { collection: rel.child, id: v, path: p, op: 'update', set: { [rel.column]: action === 'link' ? id : null }, revision: null },
						supplied: [rel.column], refs: [], parent, belongs: action === 'link' ? 'free' : 'parent' });
				});
			}
		}
	}
}

const SYSTEM = new Set(['id', 'revision', 'approval_id', 'created_at', 'created_by', 'updated_at', 'updated_by']);
/**
 * A model's natural key: its `key`, else its first declared `unique`. An import matches rows and names refs by it
 * (rule 30); an upsert never does (rule 28: an upsert names its record by `id`).
 */
export const modelKey = (m: EngineManifest, model: string): readonly string[] =>
	m.models[model]?.key ?? m.models[model]?.unique?.[0]?.fields ?? [];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const tagged = (v: Json, tag: string): Json | undefined => isObj(v) && Object.keys(v).length === 1 ? v[tag] : undefined;
/** One stored value against its kind; `null` is left to NOT NULL and the required check. */
function decodeValue(f: FieldInfo, v: Json, spec?: { kind: string; values?: readonly string[]; states?: object; shape?: object }): string | null {
	if (v === null) return null;
	const str = typeof v === 'string';
	switch (f.kind) {
		case 'text': case 'currency': return f.many ? (Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'expected a list of text') : str ? null : 'expected text';
		case 'enum': {
			const ok = (x: Json) => typeof x === 'string' && (spec?.values ?? []).includes(x);
			return (f.many ? Array.isArray(v) && v.every(ok) : ok(v)) ? null : `expected one of ${(spec?.values ?? []).join(', ')}`;
		}
		case 'state': return str && Object.hasOwn(spec?.states ?? {}, v) ? null : `'${String(v)}' is not a state`;
		case 'int': case 'duration': return Number.isSafeInteger(v) ? null : 'expected a whole number';
		case 'decimal': case 'money': {
			const s = typeof v === 'number' ? String(v) : str ? v : tagged(v, '$dec');
			return typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s) ? null : 'expected a decimal';
		}
		case 'bool': return typeof v === 'boolean' ? null : 'expected true or false';
		case 'date': { const s = str ? v : tagged(v, '$d'); return typeof s === 'string' && DATE.test(s) ? null : 'expected a date'; }
		case 'instant': { const s = str ? v : tagged(v, '$t'); return typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? null : 'expected an instant'; }
		case 'id': return str ? null : 'expected an id';
		case 'ref': return isObj(v) && Object.keys(v).length === 2 && typeof v['id'] === 'string' && (f.arms ?? []).includes(v['collection'] as string)
			? null : `expected { collection, id } with collection one of ${(f.arms ?? []).join(', ')}`;
		// X-11: a date period `{ from, to | null }` (inclusive), an instant period `{ start, end | null }`; empty or inverted refused
		case 'period': {
			const date = f.periodOf === 'date', [lo, hi] = date ? ['from', 'to'] : ['start', 'end'];
			const end = (x: Json | undefined) => { const s = isObj(x) ? tagged(x, date ? '$d' : '$t') : x; return typeof s === 'string' && (date ? DATE.test(s) : !Number.isNaN(Date.parse(s))) ? s : undefined; };
			const a = isObj(v) && Object.keys(v).every((k) => k === lo || k === hi) ? end(v[lo]) : undefined;
			if (a === undefined) return `expected a period { ${lo}, ${hi} }`;
			const b = (v as Obj)[hi] ?? null;
			if (b === null) return null;
			const z = end(b);
			if (z === undefined) return `expected a period { ${lo}, ${hi} }`;
			return (date ? a <= z : Date.parse(a) < Date.parse(z)) ? null : `'${lo}' is after '${hi}'`;
		}
		// rule 16: an authored vector is exactly `dim` finite numbers, refused here rather than by pgvector at commit
		case 'vector': return Array.isArray(v) && v.length === (f.dim ?? v.length) && v.every((x) => typeof x === 'number' && Number.isFinite(x))
			? null : `expected ${f.dim ?? 'a list of'} finite numbers`;
		// a declared `shape` is the value's input kind (§3.3.2), decoded as a typed input is, excess keys refused
		case 'json': {
			if (spec?.shape === undefined) return null;
			const d = decodeInput({ value: spec.shape } as InputSpec, { value: v });
			return d.problems.length === 0 ? null : d.problems.map((p) => `${p.path.replace(/^value\.?/, '') || 'value'} ${p.message}`).join('; ');
		}
		default: return null;
	}
}

/**
 * Defaults (rule 23a) and the required check, on a create's payload as the engine will write it. A state lands in its
 * initial value; `{ now }`/`{ today }` resolve against the invocation clock; actor defaults apply only when the actor
 * has that value. Returns the first missing required field.
 */
export function withDefaults(m: EngineManifest, cat: Catalog, model: string, values: Record<string, Json>, actor: EngineActor,
	clock: { now: string; today: string }): string | null {
	const spec = m.models[model]!;
	for (const [name, k] of Object.entries(spec.fields)) {
		if (values[name] !== undefined) continue;
		if (k.kind === 'state') { values[name] = k.initial; continue; }
		const d = k.default as Json | undefined;
		if (d === undefined) continue;
		const now = isObj(d) ? d['now'] : undefined, today = isObj(d) ? d['today'] : undefined;
		if (typeof now === 'string') values[name] = new Date(Date.parse(clock.now) + offsetMs(now)).toISOString();
		else if (typeof today === 'string') values[name] = new Date(Date.parse(`${clock.today}T00:00:00Z`) + offsetMs(today)).toISOString().slice(0, 10);
		else values[name] = d;
	}
	for (const [fk, rel] of cat.models.get(model)!.one) {
		const r = m.relationships[`${model}.${fk}`];
		if (values[fk] !== undefined || r?.default === undefined || actor.kind !== 'member') continue;
		if (r.default.actor === 'id' && rel.targets.includes('sys_user')) values[fk] = actor.id;
		else if (r.default.actor === 'party' && actor.party !== null && rel.targets.includes(actor.party.collection)) values[fk] = actor.party.id;
	}
	const required = Object.entries(spec.fields).find(([n, k]) => !k.optional && !['seq', 'sum', 'count'].includes(k.kind) && (values[n] ?? null) === null);
	if (required !== undefined) return required[0];
	const ref = [...cat.models.get(model)!.one.keys()].find((fk) => !m.relationships[`${model}.${fk}`]?.optional && (values[fk] ?? null) === null);
	return ref ?? null;
}

/** Values of `row` that `set` would change (rule 29: an update equal to the stored values writes nothing). */
export const changed = (row: RowData, set: RowData): RowData =>
	Object.fromEntries(Object.entries(set).filter(([k, v]) => !same(row[k] ?? null, v)));
const same = (a: Json, b: Json): boolean => {
	const u = (x: Json): Json => isObj(x) && Object.keys(x).length === 1 && Object.keys(x)[0]!.startsWith('$') ? Object.values(x)[0]! : x;
	const [x, y] = [u(a), u(b)];
	// numeric columns read back as text or numbers: compare those as numbers; a changed scale ('1.20') still writes
	if ((typeof x === 'number' || typeof y === 'number') && x !== null && y !== null && typeof x !== 'object' && typeof y !== 'object') return Number(x) === Number(y);
	// hook:integrations — a re-pulled value is no change (rule 29): jsonb reorders keys, timestamptz reads back as `…00Z`
	if (typeof x === 'string' && typeof y === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x) && /^\d{4}-\d{2}-\d{2}T/.test(y)) return Date.parse(x) === Date.parse(y);
	return canonical(x) === canonical(y);
};
