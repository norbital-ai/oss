// Decode and flatten (rules 21–23a): an act's input (or a callback's payload) becomes a flat list of `Change`s, one per
// row, relation actions made explicit. Decode checks the model's input allowlist at every nesting level and reports
// every offender at once; nothing is ever deleted by omission (rule 22).
import { Array as EffectArray, Predicate, Result, Schema } from 'effect';
import { inputSchema } from '@norbital-ai/std/kind';
import { encodeWire } from '@norbital-ai/std/wire';
import { Decimal } from '@norbital-ai/std/decimal';
import type { Json } from '../../decl/values.ts';
import type { Change, EngineActor, InputPath, RowData } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { LayerColumns } from '../../decl/model.ts';
import { LIMITS } from '../contracts.ts';
import type { Catalog, FieldInfo, ModelInfo } from '@norbital-ai/store';
import { clockDefault, compileVar, evaluateVar } from '@norbital-ai/std/vars';
import { canonical } from '@norbital-ai/store';
import { decodeInput, type InputSpec } from '../callables/decode.ts';

/** An input allowlist (`SelectionBase`), or `'any'` for a callback payload: every stored field and relation action. */
export type Sel =
	| 'any'
	| {
			readonly columns: readonly string[];
			readonly with?: { readonly [rel: string]: { readonly [action: string]: unknown } };
	  };
const NONE: Sel = { columns: [] };
/**
 * A model's write declaration (`create.columns` / `update.columns`, keyed by layer path) as the decode allowlist: the
 * path's columns and, per child layer, its relation actions. A create's children are created (a non-owned one linked by
 * id); an update's are created, updated and deleted (a non-owned one linked and unlinked), each row with its path's columns.
 */
export const layerSel = (
	m: EngineManifest,
	cat: Catalog,
	columns: LayerColumns,
	verb: 'create' | 'update',
	path: string,
	model: string = path
): Sel => ({
	columns: columns[path] ?? [],
	with: Object.fromEntries(
		Object.keys(columns).flatMap((p) => {
			const rel = p.startsWith(`${path}.`) ? p.slice(path.length + 1) : '';
			const many =
				rel === '' || rel.includes('.') ? undefined : cat.models.get(model)?.many.get(rel);
			if (many === undefined) return [];
			const sub = layerSel(m, cat, columns, verb, p, many.child);
			const free = m.relationships[`${many.child}.${many.column}`]?.owned
				? {}
				: verb === 'create'
					? { link: NONE }
					: { link: NONE, unlink: NONE };
			return [
				[
					rel,
					verb === 'create'
						? { create: sub, ...free }
						: { create: sub, update: sub, delete: NONE, ...free }
				]
			];
		})
	)
});
/** A change's write path: its root and each relation it was reached through (`'orders.lines'`). */
export const layerPath = (root: string, path: InputPath): string =>
	[
		root,
		...path.flatMap((part, at) => {
			const next = path[at + 1];
			return typeof part === 'string' &&
				typeof next === 'string' &&
				(ACTIONS as readonly string[]).includes(next)
				? [part]
				: [];
		})
	].join('.');
/** One flattened row change plus what the pipeline judges it by. */
export type Item = {
	change: Change;
	/** Fields the input supplied (rule 35: only these are admitted field by field; relation names included). */
	supplied: string[];
	/** Refs the input supplied (rule 36), `field → target`. */
	refs: { field: string; to: string; id: string }[];
	/** Set on a relation action: the parent row and the relation it came through. */
	parent?: { model: string; id: string; rel: string; fk: string };
	/** `link`/`unlink`/nested `update`/`delete` name an existing child that must belong to (or be free for) the parent. */
	belongs?: 'parent' | 'free';
};
type Problem = { path: InputPath; message: string };

type Obj = { readonly [k: string]: Json };
/** A relation's value: its explicit actions, or (a create tree) the list of children, an id among them a link. */
type Rel = Obj | readonly Json[];
const isList = (v: Json | undefined): v is readonly Json[] => Array.isArray(v);
const ACTIONS = ['create', 'update', 'upsert', 'link', 'unlink', 'delete'] as const;

export class Flattener {
	readonly items: Item[] = [];
	readonly problems: Problem[] = [];
	private readonly m: EngineManifest;
	private readonly cat: Catalog;
	private readonly mint: () => string;
	private readonly identities: ReadonlyMap<string, string>;
	constructor(
		m: EngineManifest,
		cat: Catalog,
		mint: () => string,
		identities: ReadonlyMap<string, string> = new Map()
	) {
		this.m = m;
		this.cat = cat;
		this.mint = mint;
		this.identities = identities;
	}

	private model(name: string): ModelInfo {
		return this.cat.models.get(name)!;
	}
	private bad(path: InputPath, message: string): void {
		this.problems.push({ path, message });
	}

	/** Decodes the columns of one input object; relation keys are returned for the caller to walk. */
	private columns(
		model: string,
		sel: Sel,
		value: Json | undefined,
		path: InputPath
	): { values: Record<string, Json>; rels: [string, Rel][]; supplied: string[] } | null {
		if (!Predicate.isObject(value)) {
			this.bad(path, 'expected an object');
			return null;
		}
		const info = this.model(model);
		const values: Record<string, Json> = {},
			rels: [string, Rel][] = [],
			supplied: string[] = [];
		for (const [k, v] of Object.entries(value)) {
			const at = [...path, k];
			const rel = info.many.get(k);
			if (rel !== undefined) {
				if (sel !== 'any' && sel.with?.[k] === undefined)
					this.bad(at, `'${k}' is not accepted here`);
				else if (Predicate.isObject(v) || isList(v)) {
					rels.push([k, v]);
					supplied.push(k);
				} else this.bad(at, 'expected relation actions');
				continue;
			}
			const f = info.fields.get(k);
			if (f === undefined || k.includes('.')) {
				// name what may be written here, so a wrong or junk name is corrected in one step
				const writable = [...info.fields]
					.filter(
						([name, x]) =>
							!x.computed &&
							!x.derived &&
							!SYSTEM.has(name) &&
							(sel === 'any' || sel.columns.includes(name))
					)
					.map(([name]) => name);
				this.bad(
					at,
					`'${k}' is not a field of ${model}${/\p{Cf}/u.test(k) ? ' (the name holds invisible characters)' : ''}; its fields: ${writable.join(', ')}`
				);
				continue;
			}
			if (f.computed || f.derived || SYSTEM.has(k)) {
				this.bad(at, `'${k}' is derived and cannot be written`);
				continue;
			}
			if (sel !== 'any' && !sel.columns.includes(k)) {
				this.bad(at, `'${k}' is not accepted here`);
				continue;
			}
			const shape = this.shapeOf(model, k);
			const problem =
				f.team && typeof v === 'string' && !Object.hasOwn(this.m.teams, v)
					? `'${v}' is not a team declared in source`
					: decodeValue(f, v, this.m.models[model]?.fields[k], shape);
			if (problem !== null) {
				this.bad(at, problem);
				continue;
			}
			if (shape !== undefined && v !== null) {
				const decoded = decodeInput({ [k]: shape }, { [k]: v });
				const wired = encodeWire(decoded.value);
				if (!Predicate.isObject(wired) || wired[k] === undefined) {
					this.bad(at, 'expected the declared field shape');
					continue;
				}
				values[k] = wired[k];
			} else
				values[k] =
					// a number for a decimal is the decimal its digits spell, exact to every callback and the store
					typeof v === 'number' && (f.kind === 'decimal' || f.kind === 'money') ? spelled(v) : v;
			supplied.push(k);
		}
		return { values, rels, supplied };
	}
	private shapeOf(model: string, field: string): InputSpec[string] | undefined {
		const spec = this.m.models[model]?.fields[field];
		const shape =
			spec?.kind === 'custom'
				? this.m.customFields[spec.of]?.['shape']
				: spec?.kind === 'json'
					? spec.shape
					: spec?.kind === 'list' || spec?.kind === 'object'
						? spec
						: undefined;
		if (!isInputKind(shape)) return undefined;
		return spec?.kind === 'custom' && spec.many ? { kind: 'list', of: shape } : shape;
	}
	private refsOf(model: string, values: Record<string, Json>): Item['refs'] {
		const info = this.model(model);
		return Object.entries(values).flatMap(([k, v]) => {
			const one = info.one.get(k);
			if (one === undefined) {
				const shape = this.shapeOf(model, k);
				if (shape === undefined || v === null) return [];
				return decodeInput({ [k]: shape }, { [k]: v }).refs.map((ref) => ({
					field: ref.field,
					to: ref.model,
					id: ref.id
				}));
			}
			// an exclusive arc names its arm (`RecordRef`, decoded against the arms)
			const ref = one.targets.length > 1 && Predicate.isObject(v) ? v : undefined;
			return typeof v === 'string'
				? [{ field: k, to: one.targets[0]!, id: v }]
				: ref !== undefined
					? [{ field: k, to: String(ref['model']), id: String(ref['id']) }]
					: [];
		});
	}
	private depth(path: InputPath): boolean {
		if (
			path.filter((p) => typeof p === 'string' && (ACTIONS as readonly string[]).includes(p))
				.length <= LIMITS.writeDepth
		)
			return true;
		this.bad(path, `relation actions nest at most ${LIMITS.writeDepth} deep`);
		return false;
	}

	create(
		model: string,
		sel: Sel,
		value: Json | undefined,
		path: InputPath,
		parent?: Item['parent'],
		upsert?: { on: readonly string[]; onConflict: 'update' | 'keep' },
		named?: string
	): void {
		const d = this.columns(model, sel, value, path);
		if (d === null) return;
		if (named !== undefined && upsert !== undefined) d.values['id'] = named; // an upsert by id: resolution reads it, and it is never written
		// the parent key a relation action implies is not a caller-supplied ref (rule 36)
		const refs = this.refsOf(model, d.values);
		if (parent !== undefined) d.values[parent.fk] = parent.id;
		const minted = this.mint();
		const id =
			this.identities.get(JSON.stringify([model, path])) ??
			(upsert === undefined && named !== undefined ? named : minted);
		const change: Change =
			upsert === undefined
				? { model: model, id, path, op: 'create', values: d.values }
				: {
						model: model,
						id,
						path,
						op: 'upsert',
						values: d.values,
						on: upsert.on,
						onConflict: upsert.onConflict
					};
		this.items.push({
			change,
			supplied: d.supplied,
			refs,
			...(parent === undefined ? {} : { parent })
		});
		this.relations(model, sel, id, d.rels, path);
	}

	update(
		model: string,
		sel: Sel,
		id: Json | undefined,
		set: Json | undefined,
		revision: number | null,
		path: InputPath,
		parent?: Item['parent']
	): void {
		if (typeof id !== 'string') {
			this.bad([...path, 'target'], 'expected an id');
			return;
		}
		const d = this.columns(model, sel, set, [...path, 'set']);
		if (d === null) return;
		this.items.push({
			change: { model: model, id, path, op: 'update', set: d.values, revision },
			supplied: d.supplied,
			refs: this.refsOf(model, d.values),
			...(parent === undefined ? {} : { parent, belongs: 'parent' as const })
		});
		this.relations(model, sel, id, d.rels, [...path, 'set']);
	}

	delete(
		model: string,
		id: Json | undefined,
		revision: number | null,
		path: InputPath,
		parent?: Item['parent']
	): void {
		if (typeof id !== 'string') {
			this.bad(path, 'expected an id');
			return;
		}
		this.items.push({
			change: { model: model, id, path, op: 'delete', revision },
			supplied: [],
			refs: [],
			...(parent === undefined ? {} : { parent, belongs: 'parent' as const })
		});
	}

	/**
	 * A relation-action upsert (rule 28): the child row names its record by `id`: a row with an id updates that child (or,
	 * `{ values, onConflictDoUpdate: false }`, leaves it), a row without one is created. A bare values object (the
	 * callback payload's shape) updates.
	 */
	private upsert(model: string, sel: Sel, v: Json, path: InputPath, parent: Item['parent']): void {
		const wrapped = Predicate.isObject(v) && 'values' in v && 'onConflictDoUpdate' in v;
		if (wrapped && (typeof v['onConflictDoUpdate'] !== 'boolean' || Object.keys(v).length !== 2)) {
			this.bad(path, 'expected { values, onConflictDoUpdate }');
			return;
		}
		const at = wrapped ? [...path, 'values'] : path,
			row = wrapped ? v['values'] : v;
		if (!Predicate.isObject(row)) {
			this.bad(at, 'expected an object');
			return;
		}
		const { id, ...values } = row;
		if (id === undefined) {
			this.create(model, sel, values, at, parent);
			return;
		}
		if (typeof id !== 'string') {
			this.bad([...at, 'id'], 'expected an id');
			return;
		}
		this.create(
			model,
			sel,
			values,
			at,
			parent,
			{ on: ['id'], onConflict: wrapped && v['onConflictDoUpdate'] === false ? 'keep' : 'update' },
			id
		);
	}

	/** Explicit relation actions (rule 22): each names its rows; an empty array or an omitted key does nothing. */
	private relations(
		model: string,
		sel: Sel,
		id: string,
		rels: [string, Rel][],
		path: InputPath
	): void {
		for (const [name, actions] of rels) {
			const rel = this.model(model).many.get(name)!;
			const spec = this.m.relationships[`${rel.child}.${rel.column}`];
			const parent = { model: model, id, rel: name, fk: rel.column };
			const allowed = sel === 'any' ? undefined : sel.with?.[name];
			// a create tree's list keeps each child's index: an object creates, an id links
			const groups = new Map<string, (readonly [Json, InputPath])[] | null>();
			if (isList(actions))
				actions.forEach((v, i) => {
					const action = typeof v === 'string' ? 'link' : 'create';
					const list = groups.get(action) ?? [];
					list.push([v, [...path, name, action, i]]);
					groups.set(action, list);
				});
			else
				for (const [action, list] of Object.entries(actions))
					groups.set(
						action,
						isList(list) ? list.map((v, i) => [v, [...path, name, action, i]] as const) : null
					);
			for (const [action, list] of groups) {
				const at = [...path, name, action];
				if (
					!(ACTIONS as readonly string[]).includes(action) ||
					(allowed !== undefined && allowed[action] === undefined)
				) {
					this.bad(at, `'${action}' is not accepted here`);
					continue;
				}
				if (list === null) {
					this.bad(at, 'expected a list');
					continue;
				}
				if (!this.depth(at)) continue;
				const sub: Sel = allowed === undefined ? 'any' : (allowed[action] as Sel);
				list.forEach(([v, p]) => {
					if (action === 'create') this.create(rel.child, sub, v, p, parent);
					else if (action === 'upsert') this.upsert(rel.child, sub, v, p, parent);
					else if (action === 'update')
						Predicate.isObject(v)
							? this.update(rel.child, sub, v['target'], v['set'], null, p, parent)
							: this.bad(p, 'expected { target, set }');
					else if (action === 'delete') this.delete(rel.child, v, null, p, parent);
					else if (spec?.owned) this.bad(p, `an owned ${rel.child} never changes its parent`);
					else if (typeof v !== 'string') this.bad(p, 'expected an id');
					// link and unlink are FK updates of the child (rule 22); `unlink` of a required ref fails NOT NULL (`required`)
					else
						this.items.push({
							change: {
								model: rel.child,
								id: v,
								path: p,
								op: 'update',
								set: { [rel.column]: action === 'link' ? id : null },
								revision: null
							},
							supplied: [rel.column],
							refs: [],
							parent,
							belongs: action === 'link' ? 'free' : 'parent'
						});
				});
			}
		}
	}
}

const SYSTEM = new Set(['id', 'revision', 'created_at', 'created_by', 'updated_at', 'updated_by']);
/**
 * A model's natural key: its `key`, else its first declared `unique`. An import matches rows and names refs by it
 * (rule 30); an upsert never does (rule 28: an upsert names its record by `id`).
 */
export const modelKey = (m: EngineManifest, model: string): readonly string[] =>
	m.models[model]?.key ?? m.models[model]?.unique?.[0]?.fields ?? [];

/** A JSON number as the decimal its shortest digits spell (`1.5e-7` as 0.00000015). */
const spelled = (v: number): Json => {
	const text = String(v),
		fraction = /\.(\d+)/.exec(text)?.[1]?.length ?? 0,
		exponent = Number(/e-(\d+)$/.exec(text)?.[1] ?? 0);
	return encodeWire(Decimal.fromNumber(v, fraction + exponent));
};
const isInputKind = (v: unknown): v is InputSpec[string] =>
	v !== null && typeof v === 'object' && 'kind' in v && typeof v.kind === 'string';
/** One stored value against its kind; `null` is left to NOT NULL and the required check. */
export function decodeValue(
	f: FieldInfo,
	v: Json,
	spec?: EngineManifest['models'][string]['fields'][string],
	shape?: InputSpec[string]
): string | null {
	if (v === null) return null;
	const str = typeof v === 'string';
	switch (f.kind) {
		case 'text':
		case 'currency':
			return f.many
				? EffectArray.isArray<typeof v>(v) && v.every((x) => typeof x === 'string')
					? null
					: 'expected a list of text'
				: str
					? null
					: 'expected text';
		case 'enum': {
			if (spec?.kind !== 'enum') return 'expected the declared enum';
			const ok = (x: Json) => typeof x === 'string' && spec.values.includes(x);
			return (f.many ? EffectArray.isArray<typeof v>(v) && v.every(ok) : ok(v))
				? null
				: `expected one of ${spec.values.join(', ')}`;
		}
		case 'state':
			if (spec?.kind !== 'state') return 'expected the declared state';
			return str && Object.hasOwn(spec.states, v) ? null : `'${String(v)}' is not a state`;
		case 'int':
		case 'duration':
			return Number.isSafeInteger(v) ? null : 'expected a whole number';
		// D6: an authored literal (decimal text or a number) or the wire's `{ $dec }`
		case 'decimal':
		case 'money':
			return Result.isSuccess(
				Schema.decodeUnknownResult(inputSchema({ kind: 'decimal', scale: 0 }))(v)
			)
				? null
				: 'expected a decimal';
		case 'bool':
			return typeof v === 'boolean' ? null : 'expected true or false';
		// D6: a date and an instant are their ISO text, the one shape the wire carries both ways
		case 'date':
			return Result.isSuccess(Schema.decodeUnknownResult(inputSchema({ kind: 'date' }))(v))
				? null
				: 'expected a date';
		case 'instant':
			return str && !Number.isNaN(Date.parse(v)) ? null : 'expected an instant';
		case 'id':
			return str ? null : 'expected an id';
		case 'ref':
			return Predicate.isObject(v) &&
				Object.keys(v).length === 2 &&
				typeof v['id'] === 'string' &&
				typeof v['model'] === 'string' &&
				(f.arms ?? []).includes(v['model'])
				? null
				: `expected { model, id } with model one of ${(f.arms ?? []).join(', ')}`;
		// X-11: a date period `{ from, to | null }` (inclusive), an instant period `{ start, end | null }`; empty or inverted refused
		case 'period': {
			const date = f.periodOf === 'date',
				[lo, hi] = date ? ['from', 'to'] : ['start', 'end'];
			const end = (x: Json | undefined) =>
				typeof x === 'string' &&
				Result.isSuccess(
					Schema.decodeUnknownResult(inputSchema(date ? { kind: 'date' } : { kind: 'instant' }))(x)
				)
					? x
					: undefined;
			if (!Predicate.isObject(v) || !Object.keys(v).every((k) => k === lo || k === hi))
				return `expected a period { ${lo}, ${hi} }`;
			const a = end(v[lo]);
			if (a === undefined) return `expected a period { ${lo}, ${hi} }`;
			const b = v[hi] ?? null;
			if (b === null) return null;
			const z = end(b);
			if (z === undefined) return `expected a period { ${lo}, ${hi} }`;
			return (date ? a <= z : Date.parse(a) < Date.parse(z)) ? null : `'${lo}' is after '${hi}'`;
		}
		// rule 16: an authored vector is exactly `dim` finite numbers, refused here rather than by pgvector at commit
		case 'vector':
			return EffectArray.isArray<typeof v>(v) &&
				v.length === (f.dim ?? v.length) &&
				v.every((x) => typeof x === 'number' && Number.isFinite(x))
				? null
				: `expected ${f.dim ?? 'a list of'} finite numbers`;
		// a declared `shape` is the value's input kind (§3.3.2), decoded as a typed input is, excess keys refused
		case 'list':
		case 'object': {
			if (spec?.kind !== 'list' && spec?.kind !== 'object')
				return 'expected the declared field shape';
			return Result.isSuccess(Schema.decodeUnknownResult(inputSchema(spec))(v))
				? null
				: 'expected the declared field shape';
		}
		case 'json':
		case 'custom': {
			if (shape === undefined) return null;
			const d = decodeInput({ value: shape }, { value: v });
			return d.problems.length === 0
				? null
				: d.problems
						.map((p) => `${p.path.replace(/^value\.?/, '') || 'value'} ${p.message}`)
						.join('; ');
		}
		default:
			return null;
	}
}

/**
 * Defaults (rule 23a) and the required check, on a create's payload as the engine will write it. A state lands in its
 * initial value; `{ var: 'now' }`/`{ var: 'today + days(7)' }` resolve against the invocation clock; requestor defaults
 * (`{ var: 'requestor.id' }`) apply only when the requestor has that value (the system identity, an automation run, has
 * none: its code sets the field). Returns the first missing required field.
 */
export function withDefaults(
	m: EngineManifest,
	cat: Catalog,
	model: string,
	values: Record<string, Json>,
	actor: EngineActor,
	clock: { now: string; today: string }
): string | null {
	const spec = m.models[model]!;
	for (const [name, k] of Object.entries(spec.fields)) {
		if (values[name] !== undefined) continue;
		if (k.kind === 'state') {
			values[name] = k.initial;
			continue;
		}
		const d = k.default;
		if (d === undefined) continue;
		const text =
			Predicate.isObject(d) && Object.keys(d).length === 1 && typeof d['var'] === 'string'
				? d['var']
				: undefined;
		const compiled =
			text !== undefined && clockDefault(text) !== undefined ? compileVar(text) : undefined;
		values[name] = compiled === undefined || 'error' in compiled ? d : evaluateVar(compiled, clock);
	}
	// a visitor's anonymous user is its requestor id too (it owns what it creates)
	const requestor = actor;
	const id =
		requestor?.kind === 'member'
			? requestor.id
			: requestor?.kind === 'visitor' && requestor.anonymous === true
				? requestor.visitor
				: undefined;
	for (const [fk, rel] of cat.models.get(model)!.one) {
		const r = m.relationships[`${model}.${fk}`];
		if (values[fk] !== undefined || r?.default === undefined || id === undefined) continue;
		if (r.default.var === 'requestor.id' && rel.targets.includes('sys_user')) values[fk] = id;
		else if (
			requestor?.kind === 'member' &&
			r.default.var === 'requestor.party' &&
			requestor.party !== null &&
			rel.targets.includes(requestor.party.model)
		)
			values[fk] = requestor.party.id;
	}
	const required = Object.entries(spec.fields).find(
		([n, k]) =>
			!k.optional && !['seq', 'sum', 'count'].includes(k.kind) && (values[n] ?? null) === null
	);
	if (required !== undefined) return required[0];
	const ref = [...cat.models.get(model)!.one.keys()].find(
		(fk) => !m.relationships[`${model}.${fk}`]?.optional && (values[fk] ?? null) === null
	);
	return ref ?? null;
}

/** Values of `row` that `set` would change (rule 29: an update equal to the stored values writes nothing). */
export const changed = (row: RowData, set: RowData): RowData =>
	Object.fromEntries(Object.entries(set).filter(([k, v]) => !same(row[k] ?? null, v)));
const same = (a: Json, b: Json): boolean => {
	const u = (x: Json): Json =>
		Predicate.isObject(x) && Object.keys(x).length === 1 && Object.keys(x)[0]!.startsWith('$')
			? Object.values(x)[0]!
			: x;
	const [x, y] = [u(a), u(b)];
	// numeric columns read back as text or numbers: compare those as numbers; a changed scale ('1.20') still writes
	if (
		(typeof x === 'number' || typeof y === 'number') &&
		x !== null &&
		y !== null &&
		typeof x !== 'object' &&
		typeof y !== 'object'
	)
		return Number(x) === Number(y);
	// hook:integrations — a re-pulled value is no change (rule 29): jsonb reorders keys, timestamptz reads back as `…00Z`
	if (
		typeof x === 'string' &&
		typeof y === 'string' &&
		/^\d{4}-\d{2}-\d{2}T/.test(x) &&
		/^\d{4}-\d{2}-\d{2}T/.test(y)
	)
		return Date.parse(x) === Date.parse(y);
	return canonical(x) === canonical(y);
};
