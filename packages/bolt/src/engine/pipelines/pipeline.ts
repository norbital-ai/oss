// Pipelines (§3.3.5, rule 30): a collection's file import and export. An import's rows enter through the
// collection's write pipeline as the caller, in one act (an import on a keyed collection, else create); an export is
// `read({ all: true })` under the caller's scope and masks, encoded and stored as a file. From the browser each is a run of
// the platform automation `<c>.pipeline` (input `{ mode: 'import', file, accept? } | { mode: 'template' } | { mode: 'export' }`),
// started as its caller (the run's `starter`), so `RunStatus` shows it and a template's or export's `FileRef` is the run's
// output. An import file is JSON (decoded against the declared input) or xlsx (the input's one list of objects, by header);
// a `scope` makes it a set (the rows in scope it leaves out are deleted in the same act); `check` findings and decode
// problems come back as the run's `{ applied: false, findings }` until no `refuse` is left and every `warn` is accepted.
import { Clock, Crypto, Effect, Layer, Option, Predicate, Result, Schema } from 'effect';
import { isPlainDate } from '@norbital-ai/std/date';
import { encodeWire } from '@norbital-ai/std/wire';
import { localOf } from '@norbital-ai/std/zone';
import {
	Pipelines,
	Manifest,
	Reads,
	Callables,
	Identity,
	Guest,
	RunHandlers,
	type Finding,
	type Imported,
	type Bridge,
	type GuestShape,
	type ReadsShape,
	type CallablesShape,
	type PipelinesShape,
	type IdentityShape,
	type RunHandler,
	type ShapeOf
} from '../services.ts';
import { Files } from '../ports.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Json } from '../../decl/values.ts';
import type { Holder } from '../access/authority.ts';
import type { Authority, Bindings, CrossAnswer, Invocation } from '../contracts.ts';
import { LIMITS } from '../contracts.ts';
import { type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalogOf } from '../access/pred.ts';
import { decodeInput, type InputSpec } from '../callables/decode.ts';

import { xlsxCells, xlsxOf, type Cell } from '../files/xlsx.ts';
import * as ir from '../../protocol/ir.ts';
import { modelKey } from '../write/flatten.ts';
import { databaseValue } from '../write/sql.ts';

type ImportData = NonNullable<EngineManifest['pipelines'][string]['import']>;
type Kind = InputSpec[string];
type PipelinesConfig = {
	crypto: Crypto.Crypto;
	engine: {
		manifest: EngineManifest;
		calls: CallablesShape;
		read: ReadsShape['run'];
		db: TenantDbShape;
		authority: IdentityShape['authority'];
	};
	bindings: Effect.Effect<Bindings>;
	guest: GuestShape;
	files: ShapeOf<typeof Files>;
};
/** A platform run's handler (runs area `platform`): its input and the run's id and starter. */
type Handler = RunHandler;
/** The caller of an import or export and its act's rule-31 key. */
type Caller = { authority: Authority; bindings: Bindings; key: string; issuedAt: string };
type Obj = { readonly [k: string]: Json };

function makePipelines(config: PipelinesConfig) {
	const m = config.engine.manifest;
	const declared = <K extends 'import' | 'export'>(c: string, kind: K) =>
		Effect.try({
			try: () => {
				const spec = m.pipelines[c]?.[kind];
				if (spec === undefined)
					throw BoltError.make('unknownPipeline', 'decode', `'${c}' declares no ${kind}`);
				return spec;
			},
			catch: (error) =>
				error instanceof BoltError ? error : BoltError.make('internal', 'decode', String(error))
		});

	const ops = {
		/**
		 * `records(input)`, then `known(ctx, records, { context })` once, then per record `map(record, { known, context })`
		 * (`null` skips it) and each `related[r](record, { known, context })`, then `check(ctx, { input, records, rows, known,
		 * context })`. Every row, the scope's deletes and the related rows are one act: one statement, one refusal refuses all.
		 */
		import: Effect.fn('Pipelines.import')(function* (
			c: string,
			input: Json,
			caller: Caller,
			options: Parameters<PipelinesShape['import']>[3] = {}
		): Effect.fn.Return<Imported, import('../errors.ts').EngineError> {
			const spec = yield* declared(c, 'import'),
				context = yield* contextOf(c, spec, options.context);
			const decoded = decodeInput(spec.input, input);
			if (decoded.problems.length > 0)
				return {
					applied: false,
					findings: decoded.problems.map((problem) => problemFinding(spec.input, input, problem))
				};
			const typedInput = encodeWire(decoded.value);
			const body = pipelineBody(config, caller.authority, caller.bindings, caller.key);
			const records = yield* body(`pipeline.${c}.spec.import.records`, [typedInput]);
			if (!Array.isArray(records))
				return yield* Effect.fail(
					BoltError.make('invalidRecords', 'guest', "an import's records returns a list")
				);
			const known =
				spec.known === undefined
					? null
					: yield* body(`pipeline.${c}.spec.import.known`, [{ $ctx: true }, records, { context }]);
			const x = { known, context };
			// every record through `map` (and each `related`) in one invocation, not one per record
			const mapped: Json[] = [...(yield* body.each(`pipeline.${c}.spec.import.map`, records, x))],
				related = new Map<string, Json[]>();
			for (const r of Object.keys(spec.related ?? {})) {
				const each = yield* body.each(`pipeline.${c}.spec.import.related.${r}`, records, x);
				if (!each.every(Array.isArray))
					return yield* Effect.fail(
						BoltError.make('invalidRecords', 'guest', `an import's related ${r} returns a list`)
					);
				related.set(r, each.flat());
			}
			const found = [
				...(options.findings ?? []),
				...(spec.check === undefined
					? []
					: yield* findingsOf(
							yield* body(`pipeline.${c}.spec.import.check`, [
								{ $ctx: true },
								{ input: typedInput, records, rows: mapped, known, context }
							])
						))
			];
			if (
				found.some((f) => f.severity === 'refuse') ||
				(found.length > 0 && options.accept !== true)
			)
				return { applied: false, findings: found };
			const rows = mapped.filter((r) => r !== null);
			// the act's row `i` is record `at[i]`, whose `row` (when it carries one) is its sheet row
			const at = mapped.flatMap((r, i) => (r === null ? [] : [i]));
			const extra = [...related].filter(([, list]) => list.length > 0);
			if (rows.length === 0 && extra.length === 0 && spec.scope?.of === undefined)
				return {
					applied: true,
					outcome: { kind: 'committed', output: [{ rows: [] }], records: [] },
					findings: found
				};
			// a keyed collection's rows match on its natural key: that is the import verb's (rule 30), never an upsert (by id)
			const on = modelKey(m, c),
				keyed = on.length > 0;
			if (spec.scope !== undefined && !keyed)
				return yield* Effect.fail(
					BoltError.make('invalidSpec', 'decode', `${c}'s import scope needs a collection key`)
				);
			// the scope's groups: what `of` says of every record (a blank row is still in scope), else the mapped rows
			const scoped: readonly Json[] =
				spec.scope?.of === undefined
					? rows
					: yield* body.each(`pipeline.${c}.spec.import.scope.of`, records, x);
			const where =
				spec.scope === undefined
					? null
					: scopeWhere(
							spec.scope,
							scoped.filter((x) => Predicate.isObject(x))
						);
			const prune = where === null ? {} : { prune: where };
			const acts = [
				...(rows.length === 0 && !('prune' in prune)
					? []
					: [
							{
								collection: c,
								verb: keyed ? ('import' as const) : ('create' as const),
								input: keyed ? { rows, onConflict: spec.onConflict ?? 'update', ...prune } : rows
							}
						]),
				...extra.map(([collection, list]) => ({ collection, verb: 'create' as const, input: list }))
			];
			const { outcome } = yield* config.engine.calls.acts({
				name: `${c}.pipeline`,
				acts,
				key: caller.key,
				issuedAt: caller.issuedAt,
				authority: caller.authority,
				bindings: caller.bindings,
				invocationId: caller.key,
				from: 'Server'
			});
			if (outcome.kind !== 'refused' && outcome.kind !== 'conflict')
				return { applied: true, outcome, findings: found };
			// a refusal (a guard, a lock, a grant) refuses the whole file: one finding, at its row where it names one
			// ponytail: a refusal names a row of whichever act refused; it is placed only when no related act could have
			const rec =
				outcome.kind === 'refused' && outcome.row !== undefined && extra.length === 0
					? records[at[outcome.row] ?? -1]
					: undefined;
			const message =
				outcome.kind === 'refused'
					? outcome.message
					: 'Another change touched these rows; import again.';
			return {
				applied: false,
				findings: [
					{
						row: Predicate.isObject(rec) && typeof rec['row'] === 'number' ? rec['row'] : null,
						column: outcome.kind === 'refused' && extra.length === 0 ? (outcome.field ?? '') : '',
						message,
						severity: 'refuse'
					}
				]
			};
		}),

		/** The import's sheet: the header (each list field's label, else its name; `row` is the sheet's own) and the `template` rows. */
		template: Effect.fn('Pipelines.template')(function* (c: string, caller: Caller, given?: Json) {
			const spec = yield* declared(c, 'import'),
				list = sheetList(spec.input);
			if (list === null)
				return yield* Effect.fail(
					BoltError.make(
						'unsupported',
						'decode',
						`${c}'s import input has no single list of objects to make a sheet of`
					)
				);
			const fields = Object.entries(list.of).filter(([f]) => f !== 'row');
			const rows =
				spec.template === undefined
					? []
					: yield* pipelineBody(
							config,
							caller.authority,
							caller.bindings,
							caller.key
						)(`pipeline.${c}.spec.import.template`, [
							{ $ctx: true },
							{ context: yield* contextOf(c, spec, given) }
						]);
			const records = yield* Schema.decodeUnknownEffect(
				Schema.Array(Schema.Record(Schema.String, Schema.Json))
			)(Array.isArray(rows) ? rows : []).pipe(
				Effect.mapError((error) => BoltError.make('badAnswer', 'guest', error.message, error))
			);
			return [
				fields.map(([f, k]) => headerOf(f, k)),
				...records.map((r) => fields.map(([f]) => cellOf(databaseValue(r[f] ?? null))))
			];
		}),

		/** Every row the caller may read, the declared fields only, masked as the caller sees them. */
		export: Effect.fn('Pipelines.export')(function* (
			c: string,
			caller: Pick<Caller, 'authority' | 'bindings'>
		) {
			const spec = yield* declared(c, 'export');
			const read = ir.read(catalogOf(m), c, {
				all: true,
				select: Object.fromEntries(spec.select.map((f) => [f, true])),
				...(spec.where === undefined ? {} : { where: spec.where })
			});
			const [res] = yield* config.engine.read(
				[read],
				{ as: 'caller', authority: caller.authority },
				caller.bindings
			);
			const page = yield* Schema.decodeUnknownEffect(
				Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })
			)(res).pipe(Effect.mapError((error) => BoltError.make('internal', 'decode', error.message)));
			const rows = page.rows;
			const name = `${c}-${caller.bindings.today}.${spec.format}`;
			const table = [
				spec.select,
				...rows.map((r) => spec.select.map((f) => databaseValue(r[f] ?? null)))
			];
			const bytes =
				spec.format === 'xlsx'
					? xlsxOf(table.map((r) => r.map(cellOf)))
					: new TextEncoder().encode(
							spec.format === 'json'
								? JSON.stringify(
										rows.map((r) =>
											Object.fromEntries(spec.select.map((f) => [f, databaseValue(r[f] ?? null)]))
										)
									)
								: csv(table)
						);
			return yield* store(name, bytes, MIME[spec.format]);
		})
	};
	const store = Effect.fn('Pipelines.store')(function* (
		name: string,
		bytes: Uint8Array,
		mime: string
	) {
		if (bytes.byteLength > LIMITS.storedFileBytes)
			return yield* Effect.fail(
				BoltError.make('tooLarge', 'deliver', `${name} is over ${LIMITS.storedFileBytes} bytes`)
			);
		const file = yield* config.files.put(bytes, { name, mime }).pipe(Effect.mapError(fail));
		return { file, name };
	});
	/** The page's context decoded against the import's `context` fields: an input like any, never an authority. */
	function contextOf(
		c: string,
		spec: ImportData,
		given: Json | undefined
	): Effect.Effect<Json, BoltError> {
		const value = given ?? {};
		const d = decodeInput(spec.context ?? {}, value);
		if (d.problems.length > 0)
			return Effect.fail(
				BoltError.make(
					'invalidInput',
					'decode',
					`${c}'s import context: ${d.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`
				)
			);
		return Effect.succeed(encodeWire(d.value));
	}
	const fail = (e: { message?: string; reason?: string }) =>
		BoltError.make('upstream', 'facility', e.message ?? e.reason ?? 'the files port failed');
	/** One `<c>.pipeline` run as its starter. The import file is the member's own upload to `<c>.$import`; an export is stored as `<c>.$export`. */
	const run = Effect.fn('Pipelines.run')(function* (
		c: string,
		input: Json,
		r: { id: string; starter: Holder | null }
	): Effect.fn.Return<Json, EngineError> {
		const member = r.starter?.actor.kind === 'member' ? r.starter.actor.id : null;
		if (r.starter === null || member === null)
			return yield* Effect.fail(
				BoltError.make('noTrigger', 'admission', 'a pipeline run is started by a member')
			);
		const bindings = yield* config.bindings;
		const caller: Caller = {
			authority: yield* config.engine.authority(r.starter),
			bindings,
			key: r.id,
			issuedAt: bindings.now
		};
		const x = Predicate.isObject(input) ? input : {};
		if (x['mode'] === 'export' || x['mode'] === 'template') {
			const out =
				x['mode'] === 'export'
					? yield* ops.export(c, caller)
					: yield* store(
							`${c}-template.xlsx`,
							xlsxOf(yield* ops.template(c, caller, x['context'])),
							MIME.xlsx
						);
			if (!('file' in out)) return yield* Effect.fail(fail(out));
			const ref = {
				id: yield* config.crypto.randomUUIDv4.pipe(
					Effect.mapError((error) =>
						BoltError.make(
							'unavailable',
							'facility',
							'Secure random UUID generation failed.',
							error
						)
					)
				),
				name: out.name,
				mime: out.file.mime,
				bytes: out.file.bytes,
				sha256: out.file.sha256
			};
			yield* config.engine.db.write({
				text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)`,
				params: [
					ref.id,
					ref.name,
					ref.mime,
					ref.bytes,
					out.file.key,
					ref.sha256,
					`${c}.$export`,
					caller.issuedAt,
					member
				]
			});
			return { file: ref };
		}
		const f = yield* config.engine.db.one(
			Schema.Struct({ key: Schema.String, name: Schema.String, mime: Schema.String }),
			{
				text: `SELECT key, name, mime FROM sys_file WHERE id = $1 AND field = $2 AND created_by = $3`,
				params: [String(x['file'] ?? ''), `${c}.$import`, member]
			}
		);
		if (Option.isNone(f))
			return yield* Effect.fail(
				BoltError.make('notFound', 'admission', 'The import file is not found or not yours.')
			);
		const bytes = yield* config.files
			.get(f.value.key, LIMITS.storedFileBytes)
			.pipe(Effect.mapError(fail));
		const spec = yield* declared(c, 'import');
		const sheet = f.value.mime === MIME.xlsx || f.value.name.toLowerCase().endsWith('.xlsx');
		let body: Json,
			findings: Finding[] = [];
		if (sheet) {
			let cells: Cell[][];
			cells = yield* Effect.try({
				try: () => xlsxCells(bytes),
				catch: (error) =>
					BoltError.make(
						'invalidInput',
						'decode',
						'The import file is not an xlsx workbook.',
						error
					)
			});
			({ input: body, findings } = yield* Effect.try({
				try: () => fromSheet(spec.input, cells),
				catch: (error) =>
					error instanceof BoltError
						? error
						: BoltError.make('invalidInput', 'decode', String(error))
			}));
			if (findings.length > 0) return { applied: false, findings };
		} else
			body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
				new TextDecoder().decode(bytes)
			).pipe(
				Effect.mapError((error) =>
					BoltError.make(
						'invalidInput',
						'decode',
						'The import file is neither JSON nor xlsx.',
						error
					)
				)
			);

		const r2 = yield* ops.import(c, body, caller, {
			accept: x['accept'] === true,
			...(x['context'] === undefined ? {} : { context: x['context'] })
		});
		if (!r2.applied) return { applied: false, findings: r2.findings };
		const o = r2.outcome;
		if (o.kind === 'pendingApproval') return { pendingApproval: true };
		if (o.kind !== 'committed')
			return yield* Effect.fail(BoltError.make(o.kind, 'commit', `The import ended ${o.kind}.`));
		const main = Array.isArray(o.output) ? o.output[0] : null;
		const actions = (Predicate.isObject(main) && Array.isArray(main['rows']) ? main['rows'] : [])
			.filter((x) => Predicate.isObject(x))
			.map((r) => r['action']);
		const count = (a: string) => actions.filter((x) => x === a).length;
		return {
			applied: true,
			created: Array.isArray(main) ? main.length : count('created'),
			updated: count('updated'),
			deleted: count('deleted'),
			findings: r2.findings
		};
	});
	return {
		...ops,
		/** The platform runs `<c>.pipeline`, for the runs area's `platform` map (rule 48). */
		handlers: (): { [name: string]: Handler } =>
			Object.fromEntries(
				Object.keys(m.pipelines ?? {}).map((c) => [
					`${c}.pipeline`,
					(input: Json, r: Parameters<Handler>[1]) => run(c, input, r)
				])
			)
	};
}

/** RFC 4180: a field with a comma, quote or line break is quoted, quotes doubled. */
export const csv = (rows: readonly (readonly Json[])[]): string =>
	rows
		.map((r) =>
			r
				.map((v) => {
					const s = v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
					return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
				})
				.join(',')
		)
		.join('\r\n');

const MIME = {
	csv: 'text/csv',
	json: 'application/json',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
} as const;
const cellOf = (v: Json): Cell =>
	v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
		? v
		: JSON.stringify(v);
const FindingSchema = Schema.Struct({
	row: Schema.NullOr(Schema.Number),
	column: Schema.String,
	message: Schema.String,
	severity: Schema.Literals(['warn', 'refuse'])
});
const findingsOf = (value: Json) =>
	Schema.decodeUnknownEffect(Schema.Array(FindingSchema))(value).pipe(
		Effect.mapError((error) =>
			BoltError.make(
				'badAnswer',
				'guest',
				`An import check returned invalid findings: ${error.message}`
			)
		)
	);
/** The input's one list of objects: what an xlsx upload fills and a template lays out. */
function sheetList(spec: InputSpec | undefined): { field: string; of: InputSpec } | null {
	const lists: { field: string; of: InputSpec }[] = [];
	for (const [field, kind] of Object.entries(spec ?? {}))
		if (kind.kind === 'list' && kind.of.kind === 'object')
			lists.push({ field, of: kind.of.fields });
	return lists.length === 1 ? (lists[0] ?? null) : null;
}
const headerOf = (name: string, k: Kind) => (typeof k['label'] === 'string' ? k['label'] : name);
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
/** A sheet cell as the field's kind takes it: numbers and booleans as such, an Excel date or time serial in its text, the rest as text. */
function valueOf(k: Kind, c: Exclude<Cell, null>): Json {
	const text = typeof c === 'string' ? c.trim() : String(c);
	if (k.kind === 'int' || k.kind === 'number')
		return typeof c === 'number'
			? c
			: text !== '' && Number.isFinite(Number(text))
				? Number(text)
				: text;
	if (k.kind === 'bool')
		return typeof c === 'boolean'
			? c
			: /^(true|yes|y|1)$/i.test(text)
				? true
				: /^(false|no|n|0)$/i.test(text)
					? false
					: text;
	if (k.kind === 'date' && typeof c === 'number')
		return new Date(EXCEL_EPOCH + Math.floor(c) * 86_400_000).toISOString().slice(0, 10);
	if (
		k.kind === 'date' &&
		isPlainDate(text.slice(0, 10)) &&
		/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/i.test(
			text
		)
	)
		return text.slice(0, 10);
	if (k.kind === 'time' && typeof c === 'number') {
		const m = Math.round((c % 1) * 1440);
		return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
	}
	return text;
}
/** An xlsx sheet as the import's input: header row 1 names the list's fields (name or label, any case); blank cells and rows are left out; unknown columns are ignored. */
function fromSheet(
	spec: InputSpec | undefined,
	cells: readonly (readonly Cell[])[]
): { input: Json; findings: Finding[] } {
	const list = sheetList(spec);
	if (list === null)
		throw BoltError.make(
			'unsupported',
			'decode',
			'This import takes JSON: its input has no single list of objects to read a sheet into.'
		);
	const names = new Map(
		Object.entries(list.of).flatMap(
			([f, k]) =>
				[
					[f.toLowerCase(), f],
					[headerOf(f, k).toLowerCase(), f]
				] as const
		)
	);
	const columns = (cells[0] ?? []).map((h) =>
		names.get(h === null ? '' : String(h).trim().toLowerCase())
	);
	const missing = Object.entries(list.of).filter(
		([f, k]) =>
			f !== 'row' && k.optional !== true && k.default === undefined && !columns.includes(f)
	);
	if (missing.length > 0)
		return {
			input: null,
			findings: missing.map(([f, k]) => ({
				row: 1,
				column: headerOf(f, k),
				message: 'The sheet has no such column.',
				severity: 'refuse'
			}))
		};
	const items: Obj[] = [];
	cells.forEach((line, i) => {
		if (i === 0) return;
		const item: { [f: string]: Json } = {};
		columns.forEach((f, x) => {
			const c = line[x];
			if (
				f !== undefined &&
				f !== 'row' &&
				c !== null &&
				c !== undefined &&
				!(typeof c === 'string' && c.trim() === '')
			)
				item[f] = valueOf(list.of[f]!, c);
		});
		if (Object.keys(item).length === 0) return;
		if (list.of['row']?.kind === 'number') item['row'] = i + 1;
		items.push(item);
	});
	return { input: { [list.field]: items }, findings: [] };
}
/** A decode problem at `<list>.<i>.<field>` as a finding on that sheet row and column. */
function problemFinding(
	spec: InputSpec | undefined,
	input: Json,
	p: { path: string; message: string }
): Finding {
	const list = sheetList(spec),
		[field, i, f] = p.path.split('.');
	const item =
		list !== null &&
		field === list.field &&
		Predicate.isObject(input) &&
		Array.isArray(input[field])
			? input[field][Number(i)]
			: undefined;
	const k = f === undefined ? undefined : list?.of[f];
	return {
		row: Predicate.isObject(item) && typeof item['row'] === 'number' ? item['row'] : null,
		column: k === undefined ? p.path : headerOf(f!, k),
		message: p.message,
		severity: 'refuse'
	};
}
/** A scope's `Where`: per distinct `by` values among the rows, from their first to their last `range` value. */
function scopeWhere(
	scope: { by: readonly string[]; range?: string },
	rows: readonly Obj[]
): Json | null {
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
	if (groups.size === 0) return null;
	return {
		or: [...groups.values()].map((g) => ({
			and: [
				...scope.by.map((f) => ({ [f]: g.by[f] === null ? { isNull: true } : { eq: g.by[f]! } })),
				...(scope.range === undefined || g.lo === undefined
					? []
					: [{ [scope.range]: { gte: g.lo, lte: g.hi! } }])
			]
		}))
	};
}

/**
 * A pipeline body by its dotted path in the guest bundle (`pipeline.<c>.spec.import.map`), one fresh isolate per call;
 * an argument `{ $ctx: true }` is the body's ctx, whose reads run as `authority`. `each` runs a body over many items (each
 * with `extra`) in ONE invocation, answers in order.
 */
function pipelineBody(
	config: { engine: { read: ReadsShape['run'] }; guest: GuestShape },
	authority: Authority,
	bindings: Bindings,
	prefix: string
) {
	let n = 0;
	const call = Effect.fn('Pipelines.body')(function* (path: string, args: Json) {
		const id = `${prefix}:body:${n++}`;
		const inv: Invocation = {
			id,
			kind: 'pipeline',
			target: path,
			input: args,
			ctx: {
				actor: authority.actor,
				now: bindings.now,
				today: bindings.today,
				tz: bindings.tz,
				seed: id
			},
			budget: {
				cpuMs: LIMITS.guestCpuMs,
				crossings: LIMITS.crossings.sync,
				readBytes: LIMITS.readBytes
			}
		};
		const bridge: Bridge = {
			cross: Effect.fn('Pipelines.cross')(function* (calls) {
				const reads = calls.flatMap((x) => (x._tag === 'read' ? [x.read] : []));
				const result = yield* Effect.result(
					config.engine.read(reads, { as: 'caller', authority }, bindings)
				);
				if (Result.isFailure(result))
					return calls.map((): CrossAnswer => ({
						ok: false,
						error: {
							kind: 'bolt',
							code: result.failure instanceof BoltError ? result.failure.code : 'internal',
							message: result.failure.message
						}
					}));
				const answers = result.success;
				let i = 0;
				return calls.map((x): CrossAnswer =>
					x._tag === 'read'
						? { ok: true, value: answers[i++]! }
						: {
								ok: false,
								error: {
									kind: 'bolt',
									code: 'unsupported',
									message: `a pipeline body cannot ${x._tag}`
								}
							}
				);
			})
		};
		const g = yield* config.guest.invoke(inv, bridge);
		if (g.kind === 'ok') return g.output;
		return yield* Effect.fail(
			g.kind === 'failed' ? g.error : BoltError.make('guestRefused', 'guest', g.message)
		);
	});
	return Object.assign((path: string, args: readonly Json[]) => call(path, args), {
		each: Effect.fn('Pipelines.body')(function* (
			path: string,
			items: readonly Json[],
			extra: Json
		) {
			if (items.length === 0) return [];
			const out = yield* call(path, { $each: items, with: extra });
			if (!Array.isArray(out) || out.length !== items.length)
				return yield* Effect.fail(
					BoltError.make(
						'badAnswer',
						'guest',
						`${path} answered ${Array.isArray(out) ? out.length : 'no'} results for ${items.length} items`
					)
				);
			return out;
		})
	});
}

export const PipelinesLive = Layer.effect(
	Pipelines,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			calls = yield* Callables,
			reader = yield* Reads,
			identity = yield* Identity,
			guest = yield* Guest,
			files = yield* Files,
			handlers = yield* RunHandlers;
		const bindings = Effect.gen(function* () {
			const ms = yield* Clock.currentTimeMillis;
			return {
				now: new Date(ms).toISOString(),
				today: localOf(ms, manifest.workspace.tz).date,
				tz: manifest.workspace.tz,
				params: {}
			};
		});
		const area = makePipelines({
			crypto: yield* Crypto.Crypto,
			engine: { manifest, db, calls, read: reader.run, authority: identity.authority },
			bindings,
			guest,
			files
		});
		yield* handlers.register(area.handlers());
		return Pipelines.of({ import: area.import, template: area.template, export: area.export });
	})
);
