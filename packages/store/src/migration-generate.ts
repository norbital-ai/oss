// Migration file authoring is separate from runtime validation, so a cell applying files carries no SQL generator.
import { Effect } from 'effect';
import { StoreError } from './errors.ts';
import { canonical } from './hash.ts';
import {
	archiveOf,
	checkSquashSources,
	checksumOf,
	snapshotOf,
	type MigrationFile
} from './migrate.ts';
import {
	plan,
	statements,
	type PlannedStatement,
	type Step,
	type StepRisk
} from './schema/plan.ts';
import type { SchemaSpec, FieldSpec } from './schema/spec.ts';
import type { SchemaObject } from './schema/ddl.ts';
import type { Sql } from './read/sql.ts';

/** Explicit factory reset of a dedicated namespace, including objects left by older declarations. */
export const destroyNamespace = (namespace: string): readonly Sql[] => [
	{ text: `DROP SCHEMA IF EXISTS ${q(namespace)} CASCADE`, params: [] },
	{ text: `CREATE SCHEMA ${q(namespace)}`, params: [] }
];

const refuse = (code: 'migrationInvalid', message: string) =>
	Effect.fail(StoreError.of(code, 'admission', message));

// ── inline shapes ──
const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;
const lit = (v: string): string => `'${v.replaceAll("'", "''")}'`;
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
const DATE = `'^\\d{4}-\\d{2}-\\d{2}$'`;
/** A SQL condition true where the json value `x` is no value of shape `k` (null admitted where `k` is optional). */
export function shapeViolation(x: string, k: FieldSpec, depth = 0): string {
	const v = `v${depth}`;
	const not = (cond: string) => `NOT coalesce(${cond}, false)`;
	const absent = `(${x} IS NULL OR ${x} = 'null'::jsonb)`;
	const body = (): string => {
		switch (k.kind) {
			case 'text':
			case 'currency':
				return k.kind === 'text' && k.many === true
					? `CASE WHEN jsonb_typeof(${x}) = 'array' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(${x}) ${v}(e) WHERE ${shapeViolation(`${v}.e`, { kind: 'text', ...(k.max === undefined ? {} : { max: k.max }), ...(k.format === undefined ? {} : { format: k.format }) }, depth + 1)}) ELSE true END`
					: not(
							`jsonb_typeof(${x}) = 'string'${k.kind === 'text' && k.max !== undefined ? ` AND length(${x} #>> '{}') <= ${k.max}` : ''}${k.kind === 'text' && k.format === 'email' ? ` AND ${x} #>> '{}' ~ '^[^@[:space:]]+@[^@[:space:]]+$'` : ''}`
						);
			case 'time':
				return not(
					`jsonb_typeof(${x}) = 'string' AND ${x} #>> '{}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]+)?)?$'`
				);
			case 'enum':
				return k.many === true
					? `CASE WHEN jsonb_typeof(${x}) = 'array' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(${x}) ${v}(e) WHERE ${shapeViolation(`${v}.e`, { kind: 'enum', values: k.values }, depth + 1)}) ELSE true END`
					: not(
							`jsonb_typeof(${x}) = 'string' AND ${k.values.length === 0 ? 'false' : `${x} #>> '{}' IN (${k.values.map(lit).join(', ')})`}`
						);
			case 'state':
				return not(
					`jsonb_typeof(${x}) = 'string' AND ${Object.keys(k.states).length === 0 ? 'false' : `${x} #>> '{}' IN (${Object.keys(k.states).sort().map(lit).join(', ')})`}`
				);
			case 'int':
			case 'count':
			case 'duration':
				return `CASE WHEN jsonb_typeof(${x}) = 'number' THEN NOT ((${x} #>> '{}')::numeric % 1 = 0${k.kind === 'count' ? ` AND (${x} #>> '{}')::numeric >= 0` : ''}${k.kind === 'int' && k.min !== undefined ? ` AND (${x} #>> '{}')::numeric >= ${k.min}` : ''}${k.kind === 'int' && k.max !== undefined ? ` AND (${x} #>> '{}')::numeric <= ${k.max}` : ''}) ELSE true END`;
			case 'number':
				return `CASE WHEN jsonb_typeof(${x}) = 'number' THEN NOT (true${k.min === undefined ? '' : ` AND (${x} #>> '{}')::numeric >= ${k.min}`}${k.max === undefined ? '' : ` AND (${x} #>> '{}')::numeric <= ${k.max}`}) ELSE true END`;
			case 'decimal':
			case 'money':
			case 'sum':
				return not(
					`jsonb_typeof(${x}) = 'number' OR (jsonb_typeof(${x}) = 'string' AND ${x} #>> '{}' ~ '^-?[0-9]+([.][0-9]+)?$') OR (jsonb_typeof(${x} -> '$dec') = 'string' AND ${x} ->> '$dec' ~ '^-?[0-9]+([.][0-9]+)?$')`
				);
			case 'bool':
				return `jsonb_typeof(${x}) <> 'boolean'`;
			case 'date':
				return not(
					`jsonb_typeof(${x}) = 'string' AND ${x} #>> '{}' ~ ${DATE} AND pg_input_is_valid(${x} #>> '{}', 'date')`
				);
			case 'instant':
				return not(
					`jsonb_typeof(${x}) = 'string' AND pg_input_is_valid(${x} #>> '{}', 'timestamptz')`
				);
			case 'list':
				return `CASE WHEN jsonb_typeof(${x}) = 'array' THEN (${k.min === undefined ? '' : `jsonb_array_length(${x}) < ${k.min} OR `}${k.max === undefined ? '' : `jsonb_array_length(${x}) > ${k.max} OR `}EXISTS (SELECT 1 FROM jsonb_array_elements(${x}) ${v}(e) WHERE ${shapeViolation(`${v}.e`, k.of, depth + 1)})) ELSE true END`;
			case 'object': {
				const fields = Object.entries(k.fields).map(([f, sub]) =>
					shapeViolation(
						`(${x} -> ${lit(f)})`,
						sub.default === undefined ? sub : { ...sub, optional: true },
						depth + 1
					)
				);
				if (k.rest !== undefined) {
					const names = Object.keys(k.fields);
					fields.push(
						`CASE WHEN jsonb_typeof(${x}) = 'object' THEN EXISTS (SELECT 1 FROM jsonb_each(${x}) ${v}(k, e) WHERE ${names.length === 0 ? '' : `${v}.k NOT IN (${names.map(lit).join(', ')}) AND `}${shapeViolation(`${v}.e`, k.rest, depth + 1)}) ELSE true END`
					);
				}
				return fields.length === 0
					? `jsonb_typeof(${x}) <> 'object'`
					: `(jsonb_typeof(${x}) <> 'object' OR ${fields.join(' OR ')})`;
			}
			case 'record':
				return `CASE WHEN jsonb_typeof(${x}) = 'object' THEN EXISTS (SELECT 1 FROM jsonb_each(${x}) ${v}(k, e) WHERE ${shapeViolation(`${v}.e`, k.of, depth + 1)}) ELSE true END`;
			case 'json':
				return k.shape === undefined ? 'false' : shapeViolation(x, k.shape, depth + 1);
			case 'union':
				return 'of' in k
					? k.of.length === 0
						? 'true'
						: `(${k.of.map((arm) => shapeViolation(x, arm, depth + 1)).join(' AND ')})`
					: Object.keys(k.arms).length === 0
						? 'true'
						: `(${Object.entries(k.arms)
								.map(
									([tag, fields]) =>
										`(${not(`${x} ->> ${lit(k.by)} = ${lit(tag)}`)} OR ${shapeViolation(x, { kind: 'object', fields }, depth + 1)})`
								)
								.join(' AND ')})`;
			case 'id':
				return not(
					`jsonb_typeof(${x}) = 'string' AND ${x} #>> '{}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`
				);
			case 'ref':
				return typeof k.to === 'string'
					? not(`jsonb_typeof(${x}) = 'string'`)
					: shapeViolation(
							x,
							{
								kind: 'object',
								fields: { collection: { kind: 'enum', values: k.to }, id: { kind: 'text' } }
							},
							depth + 1
						);
			case 'point':
				return shapeViolation(
					x,
					{ kind: 'object', fields: { lat: { kind: 'number' }, lng: { kind: 'number' } } },
					depth + 1
				);
			case 'vector':
				return shapeViolation(
					x,
					{ kind: 'list', min: k.dim, max: k.dim, of: { kind: 'number' } },
					depth + 1
				);
			case 'file': {
				const file: FieldSpec = {
					kind: 'object',
					fields: {
						id: { kind: 'text' },
						name: { kind: 'text' },
						mime: { kind: 'text' },
						size: { kind: 'int', optional: true }
					}
				};
				return shapeViolation(
					x,
					k.multiple === true ? { kind: 'list', of: file } : file,
					depth + 1
				);
			}
			case 'seq':
				return shapeViolation(x, { kind: k.pattern === undefined ? 'int' : 'text' }, depth + 1);
			case 'period': {
				const bad = shapeViolation(
					x,
					{
						kind: 'object',
						fields:
							k.of === 'date'
								? { from: { kind: 'date' }, to: { kind: 'date', optional: true } }
								: { start: { kind: 'instant' }, end: { kind: 'instant', optional: true } }
					},
					depth + 1
				);
				return `CASE WHEN ${bad} THEN true ELSE coalesce(${
					k.of === 'date'
						? `(${x} ->> 'from')::date > (${x} ->> 'to')::date`
						: `(${x} ->> 'start')::timestamptz >= (${x} ->> 'end')::timestamptz`
				}, false) END`;
			}
			default:
				return 'false';
		}
	};
	return k.optional === true ? `(NOT ${absent} AND ${body()})` : `(${absent} OR ${body()})`;
}
const INLINE = /*#__PURE__*/ new Set(['json', 'list', 'object', 'record']);
/** Inline fields whose shape changed from `before` to `after`: each a data step and the check that follows it. */
function shapeSteps(before: SchemaSpec | null, after: SchemaSpec): string[] {
	if (before === null) return [];
	const out: string[] = [];
	for (const [t, spec] of Object.entries(after.tables))
		for (const [f, k] of Object.entries(spec.fields)) {
			const table = before.tables[t] ?? before.tables[spec.was ?? t];
			const was = table?.fields[f] ?? table?.fields[k.was ?? f];
			if (!INLINE.has(k.kind) || was === undefined || canonical(was) === canonical(k)) continue;
			const condition =
				spec.nativeRules !== undefined
					? `${q(f)} is ${k.optional === true ? 'not ' : ''}null ${k.optional === true ? 'and' : 'or'} store_json_valid(${q(f)}, ${lit(canonical(k))}::jsonb) is not true`
					: shapeViolation(q(f), k);
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
/**
 * The next migration file from the last snapshot (`null`: none yet) to `next`, and the snapshot it leaves. `accept`
 * names the destructive steps already accepted; any other destructive step is written without its accept line, so
 * the file is refused until someone adds it.
 */
export const generate = /*#__PURE__*/ (() =>
	Effect.fn('Store.generate')(function* (
		previous: SchemaSpec | null,
		next: SchemaSpec,
		file: { readonly number: number; readonly name: string; readonly accept?: readonly string[] },
		extra: (schema: SchemaSpec) => readonly SchemaObject[] = () => []
	) {
		if (!Number.isInteger(file.number) || file.number < 1 || file.number > 9999)
			return yield* refuse(
				'migrationInvalid',
				'migration number must be an integer from 1 to 9999'
			);
		const slug = file.name
			.replace(/[^a-z0-9]+/gi, '_')
			.replace(/^_+|_+$/g, '')
			.toLowerCase();
		if (slug === '') return yield* refuse('migrationInvalid', 'a migration needs a name');
		const p = yield* plan(previous, next, extra);
		const name = `${String(file.number).padStart(4, '0')}_${slug}.sql`;
		// A replacement's drop and create belong at different ranks; grouping all of a step's statements reorders them.
		const groups: { id: string; list: PlannedStatement[] }[] = [];
		for (const s of statements(p)) {
			const last = groups.at(-1);
			if (last?.id === s.step) last.list.push(s);
			else groups.push({ id: s.step, list: [s] });
		}
		const data = shapeSteps(previous, next);
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
				`-- hazard: ${HAZARD[klass]}`,
				...[...new Set(list.flatMap((statement) => statement.risks ?? []))].map(
					(risk) => `-- operational risk: ${risk}: ${RISK[risk]}.`
				),
				...(klass === 'destructive' && file.accept?.includes(id) === true
					? [`-- accept: ${marker(id)}`]
					: []),
				...list.map(validated)
			].join('\n');
			return [...(index === dataAt ? data : []), block];
		});
		const text = [
			`-- ${name}: ${p.steps.length} step(s), from ${p.from ?? 'an empty database'} to ${p.to}.`,
			'-- Edit freely: `verify` replays every file on a scratch database and compares it with the schema.',
			'',
			[...blocks, ...(dataAt < 0 ? data : [])].join('\n\n'),
			''
		].join('\n');
		const migration: MigrationFile = { name, sql: text };
		return { file: migration, plan: p, snapshot: snapshotOf(next) };
	}))();

/** An editable fresh-database baseline. The host must replay it and its exact archive before recording a receipt. */
export const generateSquash = /*#__PURE__*/ (() =>
	Effect.fn('Store.generateSquash')(function* (
		originals: readonly MigrationFile[],
		schema: SchemaSpec,
		options: { readonly name?: string } = {},
		extra: (schema: SchemaSpec) => readonly SchemaObject[] = () => []
	) {
		const ordered = yield* checkSquashSources(originals);
		const archive = archiveOf(ordered);
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
				'migrationInvalid',
				'the squash filename must differ from every original migration'
			);
		return {
			file: baseline.file,
			replaces: ordered.map((file) => ({ name: file.name, checksum: checksumOf(file) })),
			archive,
			snapshot: baseline.snapshot
		};
	}))();
