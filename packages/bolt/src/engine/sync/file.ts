// A model's file syncs (spec §3.2, §3.3): the view toolbar's Import, Download template and Export. Each is a platform
// run `<model>.sync.<sync>` started by a member (its `starter`), so RunStatus shows it and a template's or export's
// FileRef is the run's output: `{ mode: 'import', file, accept?, context? }` | `{ mode: 'template' | 'export', format?,
// to?, context?, where? }`.
//
// Import: the member's own upload (`<model>.$import.<sync>`) is read by the parser its name or media type picks (a
// built-in on the host, a custom `parse` in the guest), every record with its `$at`; with a `schema` the records decode
// against it. The sync's `read` (guest) turns them into rows, a `scope`, findings and `related` rows; without `read` the
// records are the rows, matched by the model's `key`. Every row, the scope's deletes, the `$deleted` rows and the related
// rows are ONE act as the member, through the model's write callbacks and grants: one refusal refuses the file. Nothing is
// written while a `refuse` finding stands or a `warn` is unaccepted.
//
// Template and export: the sync's `write` (guest) returns records, written in one of the sync's tabular formats, or one
// document, converted to a declared target (`convertDocument`); without `write` they are the rows in view (the page's
// `where`, read as the member). A template is an export of what the page shows; of a document it is the header alone.
import { Array as EffectArray, Clock, Effect, Option, Predicate, Result, Schema } from 'effect';
import { csvOf } from '@norbital-ai/std/csv';
import { encodeWire } from '@norbital-ai/std/wire';
import { bindingsAt } from '../query/reader.ts';
import { databaseValue, read as storeRead } from '@norbital-ai/store';
import type { InputFields, InputKind } from '../../decl/fields.ts';
import type { SyncEntry } from '../../decl/model.ts';
import type { BuiltinParser, Finding } from '../../decl/runtime/sync.ts';
import type { Json } from '../../decl/values.ts';
import {
	Callables,
	Facilities,
	Guest,
	Identity,
	Manifest,
	Reads,
	type Bridge,
	type RunHandler
} from '../services.ts';
import { Convert, Files } from '../ports.ts';
import type { PortFailure } from '../port.ts';
import { TenantDb } from '../db/tenant-db.ts';
import {
	CONVERT_TARGETS,
	LIMITS,
	type Authority,
	type Bindings,
	type CrossAnswer,
	type Invocation,
	type InvocationKind
} from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Holder } from '../access/authority.ts';
import type { EngineError } from '../errors.ts';
import { BoltError, fromStore } from '../../protocol/errors.ts';
import { catalogOf } from '../access/pred.ts';
import { decodeInput, type InputSpec } from '../callables/decode.ts';
import { modelKey } from '../write/flatten.ts';
import { convertDocument, storeFile } from '../facilities.ts';
import {
	BUILTIN,
	headerOf,
	isBuiltin,
	parseBuiltin,
	parserFor,
	parsersOf,
	type Parser
} from '../files/parse.ts';
import { xlsxOf, type Cell } from '../files/xlsx.ts';

type Obj = { readonly [field: string]: Json };
/** The tabular formats an export or template is written in (a calendar is read, never written). */
type Format = Exclude<BuiltinParser, 'ics'>;
const FORMATS: readonly Format[] = ['xlsx', 'csv', 'tsv', 'json'];
/** One file sync: its model, its name and its manifest entry. */
type Sync = { readonly model: string; readonly sync: string; readonly entry: SyncEntry };
/** The member running a file sync, and the run's id (the act's key). */
type Caller = {
	readonly authority: Authority;
	readonly bindings: Bindings;
	readonly member: string;
	readonly key: string;
};
type FileSyncServices =
	Manifest | TenantDb | Callables | Reads | Identity | Guest | Files | Facilities | Convert;

/** A file sync's start input, as `bolt.start('<model>.sync.<sync>', input)` decodes it. */
export const FILE_SYNC_INPUT: InputSpec = {
	mode: { kind: 'enum', values: ['import', 'template', 'export'] },
	file: { kind: 'text', optional: true },
	accept: { kind: 'bool', optional: true },
	context: { kind: 'json', optional: true },
	format: { kind: 'enum', values: FORMATS, optional: true },
	to: { kind: 'enum', values: [...CONVERT_TARGETS, ...FORMATS], optional: true },
	where: { kind: 'json', optional: true }
};
const RunInput = Schema.Union([
	Schema.Struct({
		mode: Schema.Literal('import'),
		file: Schema.String,
		accept: Schema.optionalKey(Schema.Boolean),
		context: Schema.optionalKey(Schema.Json)
	}),
	Schema.Struct({
		mode: Schema.Literals(['template', 'export']),
		format: Schema.optionalKey(Schema.Literals(FORMATS)),
		to: Schema.optionalKey(Schema.Literals([...CONVERT_TARGETS, ...FORMATS])),
		context: Schema.optionalKey(Schema.Json),
		where: Schema.optionalKey(Schema.Json)
	})
]);
type ExportInput = Extract<typeof RunInput.Type, { mode: 'template' | 'export' }>;

/**
 * Who may start file sync `<model>.sync.<sync>` (its rows enter and leave as the member; the act judges each row
 * again): an import needs a create or update grant on the model, a template or export its read grant.
 */
export function fileSyncAdmits(auth: Authority, model: string, input: Json): boolean {
	if (auth.actor.kind !== 'member') return false;
	if (auth.admin) return true;
	const g = auth.models[model];
	return Predicate.isObject(input) && input['mode'] === 'import'
		? (g?.create.length ?? 0) + (g?.update.length ?? 0) > 0
		: (g?.read[model]?.length ?? 0) > 0;
}

const TEXT: InputKind = { kind: 'text' };
/**
 * A file sync's columns: its `schema` (required: the fields neither optional nor defaulted), else the model's writable
 * fields, its create and update input (a ref given as its target's id or key value; required: the model's key).
 */
function columnsOf(
	m: EngineManifest,
	s: Sync
): { readonly columns: InputFields; readonly required: readonly string[] } {
	const schema = s.entry.schema;
	if (schema !== undefined)
		return {
			columns: schema,
			required: Object.entries(schema)
				.filter(([, k]) => k.optional !== true && k.default === undefined)
				.map(([f]) => f)
		};
	const c = m.exposures[s.model],
		fields = m.models[s.model]?.fields ?? {};
	const names = new Set([
		...(c?.create?.columns[s.model] ?? []),
		...(c?.update?.columns[s.model] ?? [])
	]);
	const columns = Object.fromEntries(
		[...names].flatMap((f): [string, InputKind][] => {
			const k = fields[f];
			return k !== undefined
				? [[f, k]]
				: m.relationships[`${s.model}.${f}`] !== undefined
					? [[f, TEXT]]
					: [];
		})
	);
	return { columns, required: modelKey(m, s.model).filter((f) => f in columns) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A default import's record as its row: `$at` dropped, a ref's text that is no id names its target by its one key field. */
function rowOf(m: EngineManifest, model: string, record: Obj): Obj {
	const row: { [f: string]: Json } = {};
	for (const [f, v] of Object.entries(record)) {
		if (f === '$at') continue;
		const rel = m.relationships[`${model}.${f}`],
			key = typeof rel?.to === 'string' ? modelKey(m, rel.to) : [];
		row[f] =
			typeof v === 'string' && !UUID.test(v) && key.length === 1 && key[0] !== undefined
				? { [key[0]]: v }
				: v;
	}
	return row;
}

/** A scope's `Where`: per distinct `by` values among the rows, from their first to their last `range` value. */
function scopeWhere(
	scope: { readonly by: readonly string[]; readonly range?: string | undefined },
	rows: readonly Obj[]
): readonly Json[] {
	const groups = new Map<string, { by: { [f: string]: Json }; lo?: Json; hi?: Json }>();
	const less = (a: Json, b: Json) =>
		typeof a === 'number' && typeof b === 'number' ? a < b : String(a) < String(b);
	for (const r of rows) {
		const by = Object.fromEntries(scope.by.map((f) => [f, databaseValue(r[f] ?? null)]));
		const key = JSON.stringify(by),
			g = groups.get(key) ?? { by };
		groups.set(key, g);
		const v = scope.range === undefined ? null : databaseValue(r[scope.range] ?? null);
		if (v === null) continue;
		if (g.lo === undefined || less(v, g.lo)) g.lo = v;
		if (g.hi === undefined || less(g.hi, v)) g.hi = v;
	}
	return [...groups.values()].map((g) => ({
		and: [
			...scope.by.map((f) => {
				const v = g.by[f] ?? null;
				return { [f]: v === null ? { isNull: true } : { eq: v } };
			}),
			...(scope.range === undefined || g.lo === undefined || g.hi === undefined
				? []
				: [{ [scope.range]: { gte: g.lo, lte: g.hi } }])
		]
	}));
}
/** The stored row a `$deleted` row names, by the model's key. */
const keyWhere = (key: readonly string[], row: Obj): Json => ({
	and: key.map((f) => {
		const v = databaseValue(row[f] ?? null);
		return { [f]: v === null ? { isNull: true } : { eq: v } };
	})
});

const FindingSchema = Schema.Struct({
	at: Schema.Number,
	field: Schema.optionalKey(Schema.String),
	message: Schema.String,
	severity: Schema.Literals(['warn', 'refuse'])
});
const Rows = Schema.Array(Schema.Record(Schema.String, Schema.Json));
const ReadResult = Schema.Struct({
	rows: Rows,
	scope: Schema.optionalKey(
		Schema.Struct({ by: Schema.Array(Schema.String), range: Schema.optionalKey(Schema.String) })
	),
	findings: Schema.optionalKey(Schema.Array(FindingSchema)),
	related: Schema.optionalKey(Schema.Record(Schema.String, Rows))
});
const WriteResult = Schema.Union([
	Schema.Struct({
		document: Schema.Union([
			Schema.Struct({ markdown: Schema.String }),
			Schema.Struct({ html: Schema.String })
		]),
		name: Schema.String
	}),
	Rows
]);
const FileRow = Schema.Struct({ key: Schema.String, name: Schema.String, mime: Schema.String });
const badAnswer = (path: string) => (error: Schema.SchemaError) =>
	BoltError.make('badAnswer', 'guest', `${path} answered ${error.message}`, error);
const facilityError = (error: PortFailure) =>
	error._tag === 'Unavailable'
		? BoltError.make('unavailable', 'facility', error.reason, error)
		: BoltError.make(
				error.kind === 'invalid' || error.kind === 'tooLarge' || error.kind === 'timeout'
					? error.kind
					: 'upstream',
				'facility',
				error.message,
				error
			);

/**
 * One sync body in the guest (`model.<model>.bodies.syncs.<sync>.read|write|parse.<type>`), one fresh isolate: its
 * `ctx.db` reads under the member's authority. Parsers read uploaded bytes/text; export writers read bytes and images.
 */
const body = Effect.fn('FileSyncs.body')(function* (
	kind: Extract<InvocationKind, 'syncRead' | 'syncWrite' | 'parse'>,
	target: string,
	input: Json,
	caller: Caller
) {
	const guest = yield* Guest,
		reads = yield* Reads,
		facilities = yield* Facilities;
	const id = `${caller.key}:${kind}:${target}`;
	const invocation: Invocation = {
		id,
		kind,
		target,
		input,
		ctx: {
			actor: caller.authority.actor,
			now: caller.bindings.now,
			today: caller.bindings.today,
			tz: caller.bindings.tz,
			seed: id,
			...(kind === 'syncWrite' ? { fileExport: true as const } : {})
		},
		budget: { crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes }
	};
	const refused = (code: string, message: string): CrossAnswer => ({
		ok: false,
		error: { kind: 'bolt', code, message }
	});
	const bridge: Bridge = {
		cross: Effect.fn('FileSyncs.cross')(function* (calls) {
			const batch = calls.flatMap((x) => (x._tag === 'read' ? [x.read] : []));
			const answered =
				batch.length === 0
					? Result.succeed<readonly Json[]>([])
					: yield* Effect.result(
							reads.run(batch, { as: 'caller', authority: caller.authority }, caller.bindings)
						);
			let i = 0;
			return yield* Effect.forEach(calls, (x): Effect.Effect<CrossAnswer> =>
				x._tag === 'read'
					? Effect.succeed(
							Result.isSuccess(answered)
								? ({ ok: true, value: answered.success[i++] ?? null } satisfies CrossAnswer)
								: refused(
										answered.failure instanceof BoltError ? answered.failure.code : 'internal',
										answered.failure.message
									)
						)
					: (kind === 'parse' && (x._tag === 'files.get' || x._tag === 'files.text')) ||
						  (kind === 'syncWrite' && (x._tag === 'files.get' || x._tag === 'files.image'))
						? facilities.dispatch(x)
						: Effect.succeed(refused('unsupported', `a sync body cannot ${x._tag}`))
			);
		})
	};
	const out = yield* guest.invoke(invocation, bridge);
	if (out.kind === 'ok') return out.output;
	return yield* Effect.fail(
		out.kind === 'failed' ? out.error : BoltError.make('guestRefused', 'guest', out.message)
	);
});

/** The page's context, decoded against the sync's `context` fields: an input like any, never an authority. */
const contextOf = (s: Sync, given: Json | undefined): Effect.Effect<Json, BoltError> => {
	const d = decodeInput(s.entry.context ?? {}, given ?? {});
	return d.problems.length > 0
		? Effect.fail(
				BoltError.make(
					'invalidInput',
					'decode',
					`${s.model}.sync.${s.sync} context: ${d.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`
				)
			)
		: Effect.succeed(encodeWire(d.value));
};

/** Records with a `schema` decoded against it (all problems at once, as refusals at their `$at`), `$at` kept. */
function decodeRecords(
	schema: InputFields,
	records: readonly Obj[]
): { records: readonly Obj[]; findings: readonly Finding[] } {
	const plain = records.map(({ $at: _at, ...r }) => r);
	const d = decodeInput(
		{ records: { kind: 'list', of: { kind: 'object', fields: schema } } },
		{
			records: plain
		}
	);
	if (d.problems.length > 0)
		return {
			records: [],
			findings: d.problems.map((p) => {
				const [, i, f] = p.path.split('.'),
					at = records[Number(i)]?.['$at'],
					k = f === undefined ? undefined : schema[f];
				return {
					at: typeof at === 'number' ? at : 0,
					...(f === undefined ? {} : { field: k === undefined ? f : headerOf(f, k) }),
					message: p.message,
					severity: 'refuse' as const
				};
			})
		};
	const wire = encodeWire(d.value),
		decoded =
			Predicate.isObject(wire) && EffectArray.isArray<Json | undefined>(wire['records'])
				? wire['records']
				: [];
	return {
		records: records.map((r, i) => {
			const v = decoded[i];
			return { ...(Predicate.isObject(v) ? v : {}), $at: r['$at'] ?? 0 };
		}),
		findings: []
	};
}

/** Import: parse, decode, `read` (or the default rows), then one act as the member. */
const importFile = Effect.fn('FileSyncs.import')(function* (
	s: Sync,
	input: { readonly file: string; readonly accept?: boolean; readonly context?: Json },
	caller: Caller
): Effect.fn.Return<Json, EngineError, FileSyncServices> {
	const m = yield* Manifest,
		db = yield* TenantDb,
		files = yield* Files,
		calls = yield* Callables;
	const f = yield* db.one(FileRow, {
		text: `SELECT key, name, mime FROM sys_file WHERE id = $1 AND field = $2 AND created_by = $3`,
		params: [input.file, `${s.model}.$import.${s.sync}`, caller.member]
	});
	if (Option.isNone(f))
		return yield* Effect.fail(
			BoltError.make('notFound', 'admission', 'The import file is not found or not yours.')
		);
	const parsers = parsersOf(s.entry),
		parser: Parser | undefined = parserFor(parsers, f.value.name, f.value.mime);
	if (parser === undefined)
		return yield* Effect.fail(
			BoltError.make('invalidInput', 'decode', `${f.value.name} is not a file this import reads.`)
		);
	const context = yield* contextOf(s, input.context);
	const { columns, required } = columnsOf(m, s);
	const bytes = yield* files
		.get(f.value.key, LIMITS.storedFileBytes)
		.pipe(Effect.mapError(facilityError));
	const target = `${s.model}.${s.sync}`;
	const parsed =
		typeof parser === 'string'
			? isBuiltin(parser)
				? parseBuiltin(parser, bytes, columns, { required, tz: caller.bindings.tz })
				: yield* Effect.fail(
						BoltError.make('invalidSpec', 'decode', `'${parser}' is not a built-in parser`)
					)
			: {
					records: yield* body(
						'parse',
						`${target}.${parser.type}`,
						{ id: input.file, name: f.value.name, mime: f.value.mime },
						caller
					).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
						Effect.mapError((e) =>
							Schema.isSchemaError(e) ? badAnswer(`${target}'s ${parser.type} parser`)(e) : e
						)
					),
					findings: []
				};
	if (parsed.records.some((r) => typeof r['$at'] !== 'number'))
		return yield* Effect.fail(
			BoltError.make('badAnswer', 'guest', `${target}'s parser returned a record without its $at`)
		);
	const decoded =
		s.entry.schema === undefined || parsed.findings.length > 0
			? parsed
			: decodeRecords(s.entry.schema, parsed.records);
	if (decoded.findings.some((x) => x.severity === 'refuse'))
		return { applied: false, findings: decoded.findings };
	const records = decoded.records;

	// `read` turns records into rows; without it each record is its row (matched by the model's key)
	const read: typeof ReadResult.Type =
		s.entry.read === true
			? yield* body('syncRead', target, { records, context }, caller).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(ReadResult)),
					Effect.mapError((e) => (Schema.isSchemaError(e) ? badAnswer(`${target}'s read`)(e) : e))
				)
			: { rows: records.map((r) => ({ ...rowOf(m, s.model, r), $at: r['$at'] ?? 0 })) };
	const found = [...decoded.findings, ...(read.findings ?? [])];
	if (found.some((x) => x.severity === 'refuse') || (found.length > 0 && input.accept !== true))
		return { applied: false, findings: found };

	const key = modelKey(m, s.model);
	// a row's `$at` (its record's) places a refusal; `$deleted` rows are deleted by key, as the scope's are
	const kept = read.rows.filter((r) => r['$deleted'] !== true),
		at = kept.map((r) => (typeof r['$at'] === 'number' ? r['$at'] : 0)),
		rows = kept.map(({ $at: _at, $deleted: _deleted, ...r }) => r),
		gone = read.rows.filter((r) => r['$deleted'] === true);
	if ((read.scope !== undefined || gone.length > 0) && key.length === 0)
		return yield* Effect.fail(
			BoltError.make(
				'invalidSpec',
				'decode',
				`${target}: a scope or a $deleted row needs ${s.model} to have a key`
			)
		);
	const prune = [
		...(read.scope === undefined ? [] : scopeWhere(read.scope, read.rows)),
		...gone.map((r) => keyWhere(key, r))
	];
	const related = Object.entries(read.related ?? {}).filter(([, list]) => list.length > 0);
	const verbOf = (model: string, list: readonly Obj[], where?: Json) =>
		modelKey(m, model).length > 0
			? {
					model: model,
					verb: 'import' as const,
					input: {
						rows: list,
						onConflict: 'update',
						...(where === undefined ? {} : { prune: where })
					}
				}
			: { model: model, verb: 'create' as const, input: list };
	const acts = [
		...(rows.length === 0 && prune.length === 0
			? []
			: [verbOf(s.model, rows, prune.length === 0 ? undefined : { or: prune })]),
		...related.map(([model, list]) => verbOf(model, list))
	];
	if (acts.length === 0)
		return { applied: true, created: 0, updated: 0, deleted: 0, findings: found };
	const { outcome } = yield* calls.acts({
		name: `${s.model}.sync.${s.sync}`,
		acts,
		key: caller.key,
		issuedAt: caller.bindings.now,
		authority: caller.authority,
		bindings: caller.bindings,
		invocationId: caller.key,
		from: 'Server'
	});
	if (outcome.kind === 'refused' || outcome.kind === 'conflict') {
		// a refusal (a guard, a lock, a grant) refuses the whole file: one finding, at its record where it names one
		// ponytail: a refusal names a row of whichever act refused; it is placed only when no related act could have
		const own = related.length === 0 && outcome.kind === 'refused';
		const field = own ? outcome.field : undefined,
			k = field === undefined ? undefined : columns[field];
		return {
			applied: false,
			findings: [
				{
					at: own && outcome.row !== undefined ? (at[outcome.row] ?? 0) : 0,
					...(field === undefined ? {} : { field: k === undefined ? field : headerOf(field, k) }),
					message:
						outcome.kind === 'refused'
							? outcome.message
							: 'Another change touched these rows; import again.',
					severity: 'refuse'
				}
			]
		};
	}
	if (outcome.kind === 'pendingApproval') return { pendingApproval: true, findings: found };
	if (outcome.kind !== 'committed')
		return yield* Effect.fail(
			BoltError.make(outcome.kind, 'commit', `The import ended ${outcome.kind}.`)
		);
	const main = EffectArray.isArray<Json | undefined>(outcome.output) ? outcome.output[0] : null;
	const actions = (
		Predicate.isObject(main) && EffectArray.isArray<Json | undefined>(main['rows'])
			? main['rows']
			: []
	)
		.filter((x) => Predicate.isObject(x))
		.map((r) => r['action']);
	const count = (a: string) => actions.filter((x) => x === a).length;
	return {
		applied: true,
		created: EffectArray.isArray<typeof main>(main) ? main.length : count('created'),
		updated: count('updated'),
		deleted: count('deleted'),
		findings: found
	};
});

const cellOf = (v: Json): Cell =>
	v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
		? v
		: JSON.stringify(v);
/** Records in one tabular format: a header of the columns' labels (what an import reads back), JSON keyed by name. */
function encode(format: Format, columns: InputFields, records: readonly Obj[]): Uint8Array {
	const fields = Object.keys(columns);
	if (format === 'json')
		return new TextEncoder().encode(
			JSON.stringify(
				records.map((r) => Object.fromEntries(fields.map((f) => [f, databaseValue(r[f] ?? null)])))
			)
		);
	const table: Cell[][] = [
		Object.entries(columns).map(([f, k]) => headerOf(f, k)),
		...records.map((r) => fields.map((f) => cellOf(databaseValue(r[f] ?? null))))
	];
	return format === 'xlsx'
		? xlsxOf(table)
		: new TextEncoder().encode(csvOf(table, format === 'tsv' ? '\t' : ','));
}

/** Template and export: the `write` records or document, else the rows in view, stored as the member's own file. */
const exportFile = Effect.fn('FileSyncs.export')(function* (
	s: Sync,
	input: ExportInput,
	caller: Caller
): Effect.fn.Return<Json, EngineError, FileSyncServices> {
	const m = yield* Manifest,
		db = yield* TenantDb,
		files = yield* Files,
		reads = yield* Reads;
	const target = `${s.model}.${s.sync}`,
		owner = `${s.model}.$export.${s.sync}`;
	const { columns } = columnsOf(m, s);
	const written =
		s.entry.write === true
			? yield* body(
					'syncWrite',
					target,
					{ context: yield* contextOf(s, input.context) },
					caller
				).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(WriteResult)),
					Effect.mapError((e) => (Schema.isSchemaError(e) ? badAnswer(`${target}'s write`)(e) : e))
				)
			: null;
	if (written !== null && 'document' in written && input.mode === 'export') {
		const to =
			CONVERT_TARGETS.find((target) => target === input.to) ??
			(input.to === undefined ? m.workspace.convert?.to[0] : undefined);
		if (to === undefined)
			return yield* Effect.fail(
				BoltError.make('unsupported', 'decode', 'The workspace declares no convert target.')
			);
		const file = yield* convertDocument(written.document, {
			to,
			name: `${written.name.replace(/\.[^./]*$/, '')}.${to}`,
			for: owner,
			by: caller.member
		}).pipe(Effect.mapError(facilityError));
		return { file };
	}
	const records: readonly Obj[] =
		written === null
			? yield* Effect.gen(function* () {
					// the rows in view: the page's `where`, read as the member (scoped and masked), the model's columns only
					const fields = Object.keys(columns).filter(
						(f) =>
							m.models[s.model]?.fields[f] !== undefined ||
							m.relationships[`${s.model}.${f}`] !== undefined
					);
					const read = yield* storeRead(catalogOf(m), s.model, {
						all: true,
						select: Object.fromEntries(fields.map((f) => [f, true])),
						...(input.where === undefined ? {} : { where: input.where })
					}).pipe(Effect.mapError(fromStore));
					const [answer] = yield* reads.run(
						[read],
						{ as: 'caller', authority: caller.authority },
						caller.bindings
					);
					return (yield* Schema.decodeUnknownEffect(Schema.Struct({ rows: Rows }))(answer).pipe(
						Effect.mapError((error) => BoltError.make('internal', 'decode', error.message, error))
					)).rows;
				})
			: 'document' in written
				? []
				: written;
	const writable = parsersOf(s.entry).flatMap((p) => FORMATS.filter((x) => x === p));
	const format =
		input.format ?? FORMATS.find((format) => format === input.to) ?? writable[0] ?? 'xlsx';
	if ((input.format !== undefined || input.to !== undefined) && !writable.includes(format))
		return yield* Effect.fail(
			BoltError.make('invalidInput', 'decode', `${target} does not write ${input.format}.`)
		);
	const name = `${s.model}-${s.sync}-${input.mode === 'template' ? 'template' : caller.bindings.today}${BUILTIN[format].extension}`;
	const file = yield* storeFile({ db, manifest: m, files })(
		encode(format, columns, records),
		{ name, mime: BUILTIN[format].mime, for: owner, by: caller.member },
		`${target}'s ${input.mode}`,
		LIMITS.storedFileBytes
	).pipe(Effect.mapError(facilityError));
	return { file };
});

/** One file sync run as its starter: a member, whose authority every read and write runs under. */
const run = Effect.fn('FileSyncs.run')(function* (
	s: Sync,
	given: Json,
	r: { readonly id: string; readonly starter: Holder | null }
): Effect.fn.Return<Json, EngineError, FileSyncServices> {
	const member = r.starter?.actor.kind === 'member' ? r.starter.actor.id : null;
	if (r.starter === null || member === null)
		return yield* Effect.fail(
			BoltError.make('noTrigger', 'admission', 'A file sync run is started by a member.')
		);
	const m = yield* Manifest,
		identity = yield* Identity;
	const ms = yield* Clock.currentTimeMillis;
	const caller: Caller = {
		authority: yield* identity.authority(r.starter),
		bindings: bindingsAt(ms, m.workspace.tz),
		member,
		key: r.id
	};
	const input = yield* Schema.decodeUnknownEffect(RunInput)(given).pipe(
		Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message, error))
	);
	return input.mode === 'import'
		? yield* importFile(s, input, caller)
		: yield* exportFile(s, input, caller);
});

/**
 * The platform runs of every file sync, by name (`<model>.sync.<sync>`), for `RunHandlers.register`: B6's `SyncsLive`
 * registers them beside the remote syncs'.
 */
export const fileSyncHandlers: Effect.Effect<
	{ readonly [run: string]: RunHandler },
	never,
	FileSyncServices
> = Effect.gen(function* () {
	const services = yield* Effect.context<FileSyncServices>(),
		m = yield* Manifest;
	return Object.fromEntries(
		Object.entries(m.exposures).flatMap(([model, c]) =>
			Object.entries(c.syncs ?? {}).flatMap(([sync, entry]): [string, RunHandler][] =>
				entry.with === 'file'
					? [
							[
								`${model}.sync.${sync}`,
								(input, r) => run({ model, sync, entry }, input, r).pipe(Effect.provide(services))
							]
						]
					: []
			)
		)
	);
});
