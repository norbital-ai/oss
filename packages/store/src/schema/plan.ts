// Schema evolution: `plan(applied, next)` diffs the objects of the schema a database holds against the next schema's,
// and orders what changes into steps. Step classes: additive, rename, backfill (a derived column filled from rows),
// validating (a constraint counted against rows first, refused with its name and the offending row count), and
// destructive (a table or stored column dropped, or rebuilt; it needs acceptance). Rename hints (`was`) turn a drop plus
// an add into a RENAME. Pure: the host reads what it applied, passes it in, and executes what comes back.
import { Effect } from 'effect';
import { canonical, sha256Hex } from '../hash.ts';
import { StoreError } from '../errors.ts';
import { RANK, schemaObjects, schemaObjectsForClassification, type SchemaObject } from './ddl.ts';
import type { SchemaSpec } from './spec.ts';

export type StepClass = 'additive' | 'rename' | 'backfill' | 'validating' | 'destructive';
/** Operational costs to review even when a step preserves every stored value. */
export type StepRisk =
	'access-exclusive-lock' | 'writes-blocked' | 'table-scan' | 'table-rewrite' | 'index-rebuild';
/**
 * `drop` then `create`: a removed object only drops, a new one only creates, a changed one does both. A rename step
 * carries its one statement instead; a proven lossless storage widening carries `alter`.
 */
export type Step = {
	id: string;
	class: StepClass;
	drop: SchemaObject | null;
	create: SchemaObject | null;
	rename?: string;
	alter?: string;
	risks?: readonly StepRisk[];
};
export type Plan = {
	from: string | null;
	to: string;
	schema: SchemaSpec;
	steps: readonly Step[];
};
/** One statement of a plan, in the order it runs; `violations` counts the rows it would refuse, first. */
export type PlannedStatement = {
	readonly step: string;
	readonly sql: string;
	readonly violations?: string;
	readonly name?: string;
	readonly risks?: readonly StepRisk[];
};

/** A schema's fingerprint: SHA-256 of its canonical JSON. */
export const fingerprint = (s: SchemaSpec): string => sha256Hex(canonical(s));

const ORDER: readonly StepClass[] = ['additive', 'rename', 'backfill', 'validating', 'destructive'];
const worst = (a: StepClass, b: StepClass): StepClass =>
	ORDER.indexOf(a) > ORDER.indexOf(b) ? a : b;
const def = (o: SchemaObject) => o.shape ?? o.create.join(';\n');
const colKey = (o: SchemaObject, c: string) => `${o.table}.${c}`;
const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;
const WIDENING_RISKS: readonly StepRisk[] = [
	'access-exclusive-lock',
	'table-rewrite',
	'index-rebuild'
];
const REWRITE_RISKS: readonly StepRisk[] = ['table-rewrite'];
/** Only unconstrained physical casts proven to retain all int32 values; new semantic constraints validate separately. */
const widens = (before: SchemaObject, after: SchemaObject): boolean =>
	before.rank === 'column' &&
	before.stored === true &&
	after.stored === true &&
	before.shape === 'int' &&
	(after.shape === 'bigint' || after.shape === 'numeric') &&
	before.deps.length === 1 &&
	after.deps.length === 1 &&
	before.deps[0] === after.deps[0];

/** The renames `next` declares against `applied`: tables (`was`) and fields of a table (`was`), new name ← old. */
type Renames = {
	tables: ReadonlyMap<string, string>;
	/** `<new table>` → new field ← old field */
	fields: ReadonlyMap<string, ReadonlyMap<string, string>>;
	/** Physical columns, including each polymorphic arm. */
	columns: ReadonlyMap<string, ReadonlyMap<string, string>>;
};
const renamesOf = (applied: SchemaSpec, next: SchemaSpec): Effect.Effect<Renames, StoreError> =>
	Effect.gen(function* () {
		const tables = new Map<string, string>();
		const fields = new Map<string, Map<string, string>>();
		const columns = new Map<string, Map<string, string>>();
		const fail = (message: string) => Effect.fail(StoreError.of('schema', 'derive', message));
		for (const [name, spec] of Object.entries(next.tables)) {
			const old = spec.was !== undefined && applied.tables[name] === undefined ? spec.was : name;
			const before = applied.tables[old];
			if (old !== name) {
				if (before === undefined)
					return yield* fail(`'${name}' renames '${old}', which the database does not hold`);
				if (next.tables[old] !== undefined || [...tables.values()].includes(old))
					return yield* fail(`'${name}' renames '${old}', which another table still uses`);
				tables.set(name, old);
			}
		}
		for (const [name, spec] of Object.entries(next.tables)) {
			const before = applied.tables[tables.get(name) ?? name];
			if (before === undefined) continue;
			const own = new Map<string, string>();
			const physical = new Map<string, string>();
			for (const [f, k] of Object.entries(spec.fields)) {
				const old = k.was !== undefined && before.fields[f] === undefined ? k.was : f;
				const previous = before.fields[old];
				if (old !== f) {
					if (previous === undefined)
						return yield* fail(`'${name}.${f}' renames '${old}', which the database does not hold`);
					if (spec.fields[old] !== undefined || [...own.values()].includes(old))
						return yield* fail(`'${name}.${f}' renames '${old}', which another field still uses`);
					own.set(f, old);
				}
				const oldArms =
					previous?.kind === 'ref' && typeof previous.to !== 'string' && previous.to.length > 1
						? previous.to
						: undefined;
				const newArms =
					k.kind === 'ref' && typeof k.to !== 'string' && k.to.length > 1 ? k.to : undefined;
				if (oldArms !== undefined && newArms !== undefined) {
					for (const target of newArms) {
						const from = tables.get(target) ?? target;
						if (oldArms.includes(from) && `${f}__${target}` !== `${old}__${from}`)
							physical.set(`${f}__${target}`, `${old}__${from}`);
					}
				} else if (old !== f && oldArms === undefined && newArms === undefined)
					physical.set(f, old);
			}
			if (own.size > 0) fields.set(name, own);
			if (physical.size > 0) columns.set(name, physical);
		}
		return { tables, fields, columns };
	});
const quoted = (sql: string, from: string, to: string) =>
	sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g, (token) => (token === q(from) ? q(to) : token));
/**
 * A held object as it reads after the renames: its id, table, columns and SQL under the new names, while its `drop`
 * keeps the names the database still holds (drops run before the renames). A derived object whose definition moved
 * (a constraint over a renamed column, an FK to a renamed table) then differs and is rebuilt.
 */
function renamedObject(o: SchemaObject, r: Renames): SchemaObject {
	const back = new Map([...r.tables].map(([n, old]) => [old, n]));
	const table = back.get(o.table) ?? o.table;
	const fields = new Map(
		[...(r.fields.get(table) ?? []), ...(r.columns.get(table) ?? [])].map(([n, old]) => [old, n])
	);
	const column = (c: string) => fields.get(c) ?? c;
	const text = (sql: string) => {
		let out = sql;
		for (const [old, n] of back) out = quoted(out, old, n);
		for (const [old, n] of fields) out = quoted(out, old, n);
		return out;
	};
	const [rank, rest = ''] = o.id.split(':', 2);
	const local = rest.slice(o.table.length + 1);
	const id =
		o.table === ''
			? o.id
			: o.rank === 'table'
				? `table:${table}`
				: !rest.includes('.')
					? o.id
					: `${rank}:${table}.${['column', 'default', 'notNull', 'backfill'].includes(rank ?? '') ? column(local) : local}`;
	return {
		...o,
		id,
		table,
		deps: o.deps.map(column),
		create: o.create.map(text),
		...(o.shape === undefined ? {} : { shape: text(o.shape) })
	};
}
/** The rename statements, tables first; a polymorphic relation renames each of its arm columns. */
function renameSql(
	r: Renames,
	replacedTables: ReadonlySet<string>,
	replacedCols: ReadonlySet<string>
): Step[] {
	const primary = (table: string): string => {
		let prefix = '';
		for (const c of table) {
			if (new TextEncoder().encode(prefix + c).length > 58) break;
			prefix += c;
		}
		return `${prefix}_pkey`;
	};
	const steps: Step[] = [...r.tables]
		.filter(([n]) => !replacedTables.has(n))
		.flatMap(([n, o]): Step[] => [
			{
				id: `rename:${o}->${n}`,
				class: 'rename',
				drop: null,
				create: null,
				rename: `alter table ${q(o)} rename to ${q(n)}`
			},
			{
				id: `rename:${n}.${primary(o)}->${primary(n)}`,
				class: 'rename',
				drop: null,
				create: null,
				rename: `alter table ${q(n)} rename constraint ${q(primary(o))} to ${q(primary(n))}`
			}
		]);
	for (const [t, fields] of r.columns)
		for (const [n, o] of fields) {
			if (replacedTables.has(t) || replacedCols.has(`${t}.${n}`)) continue;
			steps.push({
				id: `rename:${t}.${o}->${n}`,
				class: 'rename',
				drop: null,
				create: null,
				rename: `alter table ${q(t)} rename column ${q(o)} to ${q(n)}`
			});
		}
	return steps;
}

/**
 * The steps from `applied` (`null`: an empty database) to `next`. `extra` is what a host keeps beside its tables (its
 * own objects for that schema), diffed and re-asserted alike.
 */
const plannerWithObjects = (objects: typeof schemaObjects) =>
	Effect.fn('Store.plan')(function* (
		applied: SchemaSpec | null,
		next: SchemaSpec,
		extra: (s: SchemaSpec) => readonly SchemaObject[] = () => []
	) {
		const r: Renames =
			applied === null
				? { tables: new Map(), fields: new Map(), columns: new Map() }
				: yield* renamesOf(applied, next);
		// what the database holds, keyed as it reads after the renames
		const held = applied === null ? [] : yield* objects(applied, extra(applied));
		const before = new Map(held.map((o) => renamedObject(o, r)).map((o) => [o.id, o]));
		const after = yield* objects(next, extra(next));
		const afterById = new Map(after.map((o) => [o.id, o]));
		const changed = new Set<string>();
		for (const [id, o] of before) {
			const n = afterById.get(id);
			if (n !== undefined && def(n) === def(o)) continue;
			if (n !== undefined) changed.add(id);
		}
		const replacedTables = new Set(
			after.filter((o) => o.rank === 'table' && changed.has(o.id)).map((o) => o.table)
		);
		const widened = new Set(
			after
				.filter((o) => {
					const old = before.get(o.id);
					return old !== undefined && !replacedTables.has(o.table) && widens(old, o);
				})
				.map((o) => o.id)
		);
		const widenedCols = new Set(
			after.filter((o) => widened.has(o.id)).map((o) => colKey(o, o.deps[0] ?? ''))
		);
		const replacedCols = new Set(
			[...before.values()]
				.filter(
					(o) =>
						o.rank === 'column' && !widened.has(o.id) && (!afterById.has(o.id) || changed.has(o.id))
				)
				.map((o) => colKey(o, o.deps[0] ?? ''))
		);
		for (const o of after)
			if (
				before.has(o.id) &&
				(replacedTables.has(o.table) ||
					(o.rank === 'fk' &&
						o.create.some((sql) =>
							[...replacedTables].some((t) => sql.includes(`references ${q(t)} (`))
						)))
			)
				changed.add(o.id);
		// PostgreSQL cannot alter a source column while a generated column uses it; only derived data is rebuilt.
		for (const o of after)
			if (
				before.has(o.id) &&
				o.rank === 'column' &&
				o.derived === true &&
				o.deps.some((c) => widenedCols.has(colKey(o, c)))
			) {
				changed.add(o.id);
				replacedCols.add(colKey(o, o.deps[0] ?? ''));
			}
		// a dropped or replaced column takes its dependants with it (`drop column … cascade`): rebuild them
		for (let grew = true; grew;) {
			grew = false;
			for (const o of after) {
				if (
					changed.has(o.id) ||
					!before.has(o.id) ||
					!o.deps.some((c) => replacedCols.has(colKey(o, c)))
				)
					continue;
				changed.add(o.id);
				if (o.rank === 'column') replacedCols.add(colKey(o, o.deps[0] ?? ''));
				grew = true;
			}
		}
		const freshTables = new Set(
			after.filter((o) => o.rank === 'table' && !before.has(o.id)).map((o) => o.table)
		);
		const createClass = (o: SchemaObject): StepClass =>
			freshTables.has(o.table)
				? 'additive'
				: o.violations !== undefined
					? 'validating'
					: o.derived === true
						? 'backfill'
						: 'additive';
		const dropClass = (o: SchemaObject): StepClass =>
			o.stored === true ? 'destructive' : 'additive';
		const steps: Step[] = [
			...renameSql(r, replacedTables, replacedCols),
			...[...before.values()]
				.filter((o) => !afterById.has(o.id) && o.drop !== null)
				.map((o): Step => ({ id: `drop:${o.id}`, class: dropClass(o), drop: o, create: null })),
			...after
				.filter((o) => changed.has(o.id) && !widened.has(o.id))
				.map((o): Step => {
					const old = before.get(o.id);
					// This versioned trigger keeps its exact signature and return contract, including its dependants.
					const header =
						'create or replace function store_row_rules() returns trigger language plpgsql as $store_rules$\n';
					const rowGuard =
						o.id === 'function:store_row_rules' &&
						old?.rank === 'function' &&
						o.rank === 'function' &&
						old.create.length === 1 &&
						o.create.length === 1 &&
						old.create[0]?.startsWith(header) &&
						o.create[0]?.startsWith(header);
					const drop = old === undefined || old.drop === null || rowGuard ? null : old;
					return {
						id: `replace:${o.id}`,
						class: worst(drop === null ? 'additive' : dropClass(drop), createClass(o)),
						drop,
						create: o
					};
				}),
			...after
				.filter((o) => widened.has(o.id))
				.map((o): Step => ({
					id: `widen:${o.id}`,
					class: 'additive',
					drop: null,
					create: null,
					alter: `alter table ${q(o.table)} alter column ${q(o.deps[0] ?? '')} type ${o.shape}`,
					risks: WIDENING_RISKS
				})),
			...after
				.filter((o) => !before.has(o.id))
				.map((o): Step => ({ id: `create:${o.id}`, class: createClass(o), drop: null, create: o }))
		];
		const p: Plan = {
			from: applied === null ? null : fingerprint(applied),
			to: fingerprint(next),
			schema: next,
			steps
		};
		return p;
	});

/** A complete executable plan uses every original SQL definition. */
export const plan = /*#__PURE__*/ plannerWithObjects(schemaObjects);
const classificationPlan = /*#__PURE__*/ plannerWithObjects(schemaObjectsForClassification);
/** Destructive ids share the complete diff, rename and dependency logic; no incomplete SQL plan escapes. */
export const destructiveSteps = (
	applied: SchemaSpec | null,
	next: SchemaSpec,
	extra: (s: SchemaSpec) => readonly SchemaObject[] = () => []
): Effect.Effect<readonly string[], StoreError> =>
	classificationPlan(applied, next, extra).pipe(
		Effect.map((p) => p.steps.filter((step) => step.class === 'destructive').map((step) => step.id))
	);

/**
 * A plan's statements in the order they run: every drop (newest rank first, under the names the database holds), the
 * renames, lossless storage alters, then every create (oldest rank first). A host's own objects that never drop are
 * re-asserted each time. Risk labels describe lock/rewrite/scan exposure, not a zero-downtime guarantee.
 */
export function statements(p: Plan, reassert: readonly SchemaObject[] = []): PlannedStatement[] {
	const drops = p.steps
		.flatMap((s) => (s.drop === null ? [] : [{ step: s.id, o: s.drop }]))
		.sort((a, b) => RANK[b.o.rank] - RANK[a.o.rank]);
	const planned = p.steps.flatMap((s) => (s.create === null ? [] : [{ step: s.id, o: s.create }]));
	const creates = [
		...planned,
		...reassert
			.filter((o) => !planned.some((x) => x.o.id === o.id))
			.map((o) => ({ step: `assert:${o.id}`, o }))
	].sort((a, b) => RANK[a.o.rank] - RANK[b.o.rank]);
	const out: PlannedStatement[] = [
		...drops.flatMap(({ step, o }) => (o.drop === null ? [] : [{ step, sql: o.drop }])),
		...p.steps.flatMap((s) => (s.rename === undefined ? [] : [{ step: s.id, sql: s.rename }])),
		...p.steps.flatMap((s) =>
			s.alter === undefined
				? []
				: [
						{
							step: s.id,
							sql: s.alter,
							...(s.risks === undefined ? {} : { risks: s.risks })
						}
					]
		),
		...creates.flatMap(({ step, o }) =>
			o.create.map((sql, i): PlannedStatement => ({
				step,
				sql,
				...(i === 0 && o.violations !== undefined
					? { violations: o.violations, name: o.meta?.name ?? o.id }
					: {}),
				...(o.rank === 'column' &&
				(o.shape === 'identity' ||
					(o.derived === true && /\bgenerated\s+always\s+as\s*\(/i.test(sql)))
					? { risks: REWRITE_RISKS }
					: {})
			}))
		)
	];
	return out.map((s) => {
		const risks = new Set<StepRisk>(s.risks);
		if (/^\s*(?:alter\s+table|drop\s+(?:table|index))\b/i.test(s.sql))
			risks.add('access-exclusive-lock');
		if (/^\s*create\s+(?:unique\s+)?index\b/i.test(s.sql)) {
			risks.add('writes-blocked');
			risks.add('table-scan');
		}
		if (s.violations !== undefined) risks.add('table-scan');
		if (/^\s*update\b/i.test(s.sql)) {
			risks.add('writes-blocked');
			risks.add('table-scan');
		}
		return risks.size === 0 ? s : { ...s, risks: [...risks] };
	});
}

/** The destructive steps `accept` does not name: `true` accepts them all. */
export const unaccepted = (p: Plan, accept: true | readonly string[] = []): readonly Step[] =>
	p.steps.filter((s) => s.class === 'destructive' && accept !== true && !accept.includes(s.id));
