// Migration file authoring is separate from runtime validation, so a cell applying files carries no SQL generator.
import { Effect } from 'effect';
import { q, literal as lit } from '@norbital-ai/std/sql';
import { StoreError } from './errors.ts';
import { canonical } from '@norbital-ai/std/hash';
import {
	archive_of,
	check_squash_sources,
	checksum_of,
	snapshot_of,
	type MigrationFile
} from './migrate.ts';
import type { SchemaSnapshot } from './schema/snapshot.ts';
import {
	plan,
	statements,
	type PlannedStatement,
	type Plan,
	type Step,
	type StepRisk
} from './schema/plan.ts';
import type { SchemaSpec, FieldSpec } from './schema/spec.ts';
import type { SchemaObject } from './schema/ddl.ts';
import type { Sql } from './read/sql.ts';

/** Explicit factory reset of a dedicated namespace, including objects left by older declarations. */
export const destroy_namespace = (namespace: string): readonly Sql[] => [
	{ text: `DROP SCHEMA IF EXISTS ${q(namespace)} CASCADE`, params: [] },
	{ text: `CREATE SCHEMA ${q(namespace)}`, params: [] }
];

const refuse = (code: 'migration_invalid', message: string) =>
	Effect.fail(StoreError.of(code, 'admission', message));

// ── inline shapes ──
const marker = (id: string): string =>
	id.replace(/[%\s()]/g, (char) =>
		char === '(' ? '%28' : char === ')' ? '%29' : encodeURIComponent(char)
	);
function validation(name: string, violations: string): string {
	const body = `declare n bigint; begin\n\texecute ${lit(violations)} into n;\n\tif n > 0 then raise exception ${lit(`${name} refuses % existing row(s)`)}, n; end if;\nend`;
	let delimiter = '$store$';
	while (body.includes(delimiter)) delimiter = `${delimiter.slice(0, -1)}_$`;
	return `do ${delimiter} ${body} ${delimiter};`;
}
const INLINE = /*#__PURE__*/ new Set(['json', 'object', 'record']);
/** Inline fields whose shape changed from `before` to `after`: each a data step and the check that follows it. */
function shapeSteps(before: SchemaSpec | null, after: SchemaSpec): string[] {
	if (before === null) return [];
	const out: string[] = [];
	for (const [t, spec] of Object.entries(after.tables))
		for (const [f, k] of Object.entries(spec.fields)) {
			const table = before.tables[t] ?? before.tables[spec.was ?? t];
			const was = table?.fields[f] ?? table?.fields[k.was ?? f];
			if (
				(!INLINE.has(k.kind) && k.many !== true) ||
				was === undefined ||
				canonical(was) === canonical(k)
			)
				continue;
			const condition = `${q(f)} is ${k.optional === true ? 'not ' : ''}null ${k.optional === true ? 'and' : 'or'} store_json_valid(${q(f)}, ${lit(canonical(k))}::jsonb) is not true`;
			const bad = `select count(*) from ${q(t)} where ${condition}`;
			out.push(
				[
					`-- step ${marker(`data:${t}.${f}`)} (data)`,
					`-- hazard: the shape of ${marker(`${t}.${f}`)} changed; rows written under the old shape may not decode under the new one.`,
					`-- Transform them here (an UPDATE over ${marker(t)}); the check below counts the rows the new shape still refuses.`,
					`-- step ${marker(`check:${t}.${f}`)} (validating)`,
					validation(`the shape of ${t}.${f}`, bad)
				].join('\n')
			);
		}
	return out;
}

// ── rendering ──
const HAZARD: Readonly<Record<Step['class'], string>> = {
	additive: 'additive: adds an object or widens a stored type without discarding existing values.',
	rename: 'rename: readers of the old name break; the data stays.',
	backfill: 'backfill: a derived column is filled from every row (time grows with the table).',
	validating:
		'validating: refuses, naming the constraint and the row count, if existing rows break it.',
	destructive:
		'DESTRUCTIVE: drops data (a table or a stored column) or rebuilds it; runs only under its accept line.'
};
const RISK: Readonly<Record<StepRisk, string>> = {
	'access-exclusive-lock':
		'may acquire an ACCESS EXCLUSIVE lock, blocking reads and writes while held',
	'writes-blocked': 'may block table writers, or conflicting row writers for an UPDATE',
	'table-scan': 'may scan existing rows; work grows with the table',
	'table-rewrite': 'may rewrite the table; disk use and work grow with existing data',
	'index-rebuild': 'may rebuild affected indexes'
};
const validated = (s: PlannedStatement): string =>
	s.violations === undefined
		? `${s.sql};`
		: [validation(s.name ?? s.step, s.violations), `${s.sql};`].join('\n');

/** Keep diff objects independent; a newly created table can declare its columns and constraints together. */
function compactStatements(p: Plan): PlannedStatement[] {
	const sql = statements(p);
	const objects = new Map(
		p.steps.flatMap((s) => (s.create === null ? [] : [[s.id, s.create] as const]))
	);
	const fresh = new Map(
		p.steps.flatMap((s) =>
			s.create?.rank === 'table' && s.drop === null ? [[s.create.table, s.id] as const] : []
		)
	);
	const definitions = new Map<string, string[]>();
	const consumed = new Set<PlannedStatement>();
	const columns = new Map<string, PlannedStatement>();
	for (const s of sql) {
		const o = objects.get(s.step);
		if (o?.rank !== 'column') continue;
		const prefix = `alter table ${q(o.table)} add column `;
		if (!s.sql.startsWith(prefix)) continue;
		columns.set(`${o.table}.${o.deps[0]}`, s);
		if (!fresh.has(o.table)) continue;
		const list = definitions.get(o.table) ?? [];
		list.push(s.sql.slice(prefix.length));
		definitions.set(o.table, list);
		consumed.add(s);
	}
	for (const s of sql) {
		const o = objects.get(s.step);
		if (o === undefined) continue;
		const column = columns.get(`${o.table}.${o.deps[0]}`);
		const prefix = `alter table ${q(o.table)} alter column ${q(o.deps[0] ?? '')} set `;
		if (o.rank === 'default' && column !== undefined && s.sql.startsWith(prefix)) {
			const value = s.sql.slice(prefix.length);
			if (column.sql.endsWith(` ${value}`)) consumed.add(s);
		}
		if (!fresh.has(o.table)) continue;
		if (o.rank === 'notNull' && column !== undefined && s.sql === `${prefix}not null`) {
			const list = definitions.get(o.table);
			const name = `alter table ${q(o.table)} add column `;
			const definition = column.sql.slice(name.length);
			const at = list?.indexOf(definition) ?? -1;
			if (list !== undefined && at >= 0) {
				list[at] = `${definition} not null`;
				consumed.add(s);
			}
		}
		const constraint = `alter table ${q(o.table)} add constraint `;
		if (o.rank === 'constraint' && s.sql.startsWith(constraint)) {
			const list = definitions.get(o.table) ?? [];
			list.push(`constraint ${s.sql.slice(constraint.length)}`);
			definitions.set(o.table, list);
			consumed.add(s);
		}
		if (o.rank === 'backfill') consumed.add(s);
	}
	return sql
		.filter((s) => !consumed.has(s))
		.map((s) => {
			const o = objects.get(s.step);
			const fields = o?.rank === 'table' ? definitions.get(o.table) : undefined;
			if (fields !== undefined && s.sql.endsWith(')'))
				return { step: s.step, sql: `${s.sql.slice(0, -1)},\n\t${fields.join(',\n\t')}\n)` };
			if (o !== undefined && fresh.has(o.table)) return { step: s.step, sql: s.sql };
			return s;
		});
}
/**
 * The next migration file from the last snapshot (`null`: none yet) to `next`, and the snapshot it leaves. `accept`
 * names the destructive steps already accepted; any other destructive step is written without its accept line, so
 * the file is refused until someone adds it.
 */
export const generate = /*#__PURE__*/ (() =>
	Effect.fn('Store.generate')(function* <E = never>(
		previous: SchemaSnapshot | null,
		next: SchemaSpec,
		file: { readonly number: number; readonly name: string; readonly accept?: readonly string[] },
		extra: (schema: SchemaSpec) => Effect.Effect<readonly SchemaObject[], E> = () => Effect.succeed([])
	) {
		if (!Number.isInteger(file.number) || file.number < 1 || file.number > 9999)
			return yield* refuse(
				'migration_invalid',
				'migration number must be an integer from 1 to 9999'
			);
		const slug = file.name
			.replace(/[^a-z0-9]+/gi, '_')
			.replace(/^_+|_+$/g, '')
			.toLowerCase();
		if (slug === '') return yield* refuse('migration_invalid', 'a migration needs a name');
		const before = previous?.schema ?? null;
		const planned = yield* plan(before, next, extra);
		const p = { ...planned, from: previous?.fingerprint ?? null };
		const name = `${String(file.number).padStart(4, '0')}_${slug}.sql`;
		// A replacement's drop and create belong at different ranks; grouping all of a step's statements reorders them.
		const groups: { id: string; list: PlannedStatement[] }[] = [];
		for (const s of compactStatements(p)) {
			const last = groups.at(-1);
			if (last?.id === s.step) last.list.push(s);
			else groups.push({ id: s.step, list: [s] });
		}
		const data = shapeSteps(before, next);
		const dataAt = groups.findIndex(({ id, list }) => {
			const create = p.steps.find((step) => step.id === id)?.create;
			return (
				create !== null &&
				create !== undefined &&
				['notNull', 'constraint'].includes(create.rank) &&
				list.some((statement) => create.create.includes(statement.sql))
			);
		});
		const blocks = groups.flatMap(({ id, list }, index) => {
			const step = p.steps.find((x) => x.id === id);
			const klass = step?.class ?? 'additive';
			const block = [
				`-- step ${marker(id)} (${klass})`,
				...(list.some((statement) => (statement.risks?.length ?? 0) > 0)
					? [
							`-- operational risk: ${[...new Set(list.flatMap((statement) => statement.risks ?? []))].join(', ')}`
						]
					: []),
				...(klass === 'destructive' && file.accept?.includes(id) === true
					? [`-- accept: ${marker(id)}`]
					: []),
				...list.map(validated)
			].join('\n');
			return [...(index === dataAt ? data : []), block];
		});
		const text = [
			`-- ${name}: ${groups.length} step(s), from ${p.from ?? 'an empty database'} to ${p.to}.`,
			'-- Edit freely: `verify` replays every file on a scratch database and compares it with the schema.',
			...[
				...new Set(
					groups.map(({ id }) => p.steps.find((step) => step.id === id)?.class ?? 'additive')
				)
			].map((klass) => `-- hazard: ${HAZARD[klass]}`),
			...[...new Set(groups.flatMap(({ list }) => list.flatMap((s) => s.risks ?? [])))].map(
				(risk) => `-- operational risk: ${risk}: ${RISK[risk]}.`
			),
			'',
			[...blocks, ...(dataAt < 0 ? data : [])].join('\n\n'),
			''
		].join('\n');
		const migration: MigrationFile = { name, sql: text };
		return { file: migration, plan: p, snapshot: snapshot_of(next) };
	}))();

/** An editable fresh-database baseline. The host must replay it and its exact archive before recording a receipt. */
export const generate_squash = /*#__PURE__*/ (() =>
	Effect.fn('Store.generate_squash')(function* <E = never>(
		originals: readonly MigrationFile[],
		schema: SchemaSpec,
		options: { readonly name?: string } = {},
		extra: (schema: SchemaSpec) => Effect.Effect<readonly SchemaObject[], E> = () => Effect.succeed([])
	) {
		const ordered = yield* check_squash_sources(originals);
		const archive = archive_of(ordered);
		const baseline = yield* generate(
			null,
			schema,
			{
				number: ordered.length,
				name: `squash_${options.name ?? ''}_${archive.slice(0, 12)}`
			},
			extra
		);
		if (ordered.some((file) => file.name === baseline.file.name))
			return yield* refuse(
				'migration_invalid',
				'the squash filename must differ from every original migration'
			);
		return {
			file: baseline.file,
			replaces: ordered.map((file) => ({ name: file.name, checksum: checksum_of(file) })),
			archive,
			snapshot: baseline.snapshot
		};
	}))();
