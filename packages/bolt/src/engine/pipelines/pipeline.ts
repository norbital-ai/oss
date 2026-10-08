// Pipelines (§3.3.5, rule 30): a collection's recurring import and export feeds. An import's rows enter through the
// collection's write pipeline as the caller, in one act (an import on a keyed collection, else create); an export is
// `read({ all: true })` under the caller's scope and masks, encoded and stored as a file. From the browser each is a run of
// the platform automation `<c>.pipeline` (input `{ mode: 'import', file, accept? } | { mode: 'template' } | { mode: 'export' }`),
// started as its caller (the run's `starter`), so `RunStatus` shows it and a template's or export's `FileRef` is the run's
// output. An import file is JSON (decoded against the declared input) or xlsx (the input's one list of objects, by header);
// a `scope` makes it a set (the rows in scope it leaves out are deleted in the same act); `check` findings and decode
// problems come back as the run's `{ applied: false, findings }` until no `refuse` is left and every `warn` is accepted.
import type { Json } from '../../decl/values.ts';
import type { FacilityError } from '../../decl/runtime/facilities.ts';
import type { Holder } from '../access/authority.ts';
import type { Authority, Bindings, Blob, FilesPort, GuestPort, Outcome } from '../contracts.ts';
import { BoltError, callPort, LIMITS } from '../contracts.ts';
import { catalogOf } from '../access/pred.ts';
import { decodeInput, type InputSpec } from '../callables/decode.ts';
import type { Engine } from '../index.ts';
import { mappingBody } from '../integrations/runner.ts';
import { xlsxCells, xlsxOf, type Cell } from '../agent/xlsx.ts';
import * as ir from '../../protocol/ir.ts';
import { modelKey } from '../write/flatten.ts';
import { untag } from '../write/sql.ts';

type ImportData = { onConflict?: 'update' | 'keep'; known?: unknown; input?: InputSpec; context?: InputSpec; scope?: { by: readonly string[]; range?: string; of?: unknown }; check?: unknown; template?: unknown;
	related?: { readonly [collection: string]: unknown } };
type ExportData = { select: readonly string[]; where?: object; format: 'csv' | 'xlsx' | 'json' };
/** A problem with one sheet row (`row` null: the file or a stored row); `refuse` blocks the import, `warn` waits for `accept`. */
export type Finding = { row: number | null; column: string; message: string; severity: 'warn' | 'refuse' };
/** An import's answer: nothing written while a `refuse` stands or a `warn` is unaccepted, else the act's outcome. */
export type Imported = { applied: false; findings: Finding[] } | { applied: true; outcome: Outcome; findings: Finding[] };
type Kind = InputSpec[string];
export type PipelinesConfig = { engine: Pick<Engine, 'manifest' | 'calls' | 'read' | 'db' | 'authority'>; bindings: () => Bindings; guest?: GuestPort; files?: FilesPort };
/** A platform run's handler (runs area `platform`): its input and the run's id and starter. */
type Handler = (input: Json, run: { id: string; starter: Holder | null }) => Promise<Json>;
/** The caller of a feed and its act's rule-31 key. */
export type Caller = { authority: Authority; bindings: Bindings; key: string; issuedAt: string };
type Obj = { readonly [k: string]: Json };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export function pipelines(config: PipelinesConfig) {
	const m = config.engine.manifest;
	const feed = <K extends 'import' | 'export'>(c: string, kind: K) => {
		const f = (m.pipelines[c] as { import?: ImportData; export?: ExportData } | undefined)?.[kind];
		if (f === undefined) throw new BoltError('unknownPipeline', 'decode', `'${c}' declares no ${kind} feed`);
		return f as NonNullable<{ import?: ImportData; export?: ExportData }[K]>;
	};
	const feeds = {
		/**
		 * `records(input)`, then `known(ctx, records, { context })` once, then per record `map(record, { known, context })`
		 * (`null` skips it) and each `related[r](record, { known, context })`, then `check(ctx, { input, records, rows, known,
		 * context })`. Every row, the scope's deletes and the related rows are one act: one statement, one refusal refuses all.
		 */
		async import(c: string, input: Json, caller: Caller, options: { accept?: boolean; findings?: readonly Finding[]; context?: Json } = {}): Promise<Imported> {
			const spec = feed(c, 'import'), context = contextOf(c, spec, options.context);
			const body = mappingBody(config, caller.authority, caller.bindings, caller.key);
			const records = await body(`pipeline.${c}.spec.import.records`, [input]);
			if (!Array.isArray(records)) throw new BoltError('invalidRecords', 'guest', 'an import\'s records returns a list');
			const known = spec.known === undefined ? null : await body(`pipeline.${c}.spec.import.known`, [{ $ctx: true }, records, { context }]);
			const x = { known, context };
			// every record through `map` (and each `related`) in one invocation, not one per record
			const mapped: Json[] = [...await body.each(`pipeline.${c}.spec.import.map`, records, x)], related = new Map<string, Json[]>();
			for (const r of Object.keys(spec.related ?? {})) {
				const each = await body.each(`pipeline.${c}.spec.import.related.${r}`, records, x);
				if (!each.every(Array.isArray)) throw new BoltError('invalidRecords', 'guest', `an import's related ${r} returns a list`);
				related.set(r, each.flat());
			}
			const found = [...options.findings ?? [], ...spec.check === undefined ? []
				: findingsOf(await body(`pipeline.${c}.spec.import.check`, [{ $ctx: true }, { input, records, rows: mapped, known, context }]))];
			if (found.some((f) => f.severity === 'refuse') || (found.length > 0 && options.accept !== true)) return { applied: false, findings: found };
			const rows = mapped.filter((r) => r !== null);
			// the act's row `i` is record `at[i]`, whose `row` (when it carries one) is its sheet row
			const at = mapped.flatMap((r, i) => r === null ? [] : [i]);
			const extra = [...related].filter(([, list]) => list.length > 0);
			if (rows.length === 0 && extra.length === 0 && spec.scope?.of === undefined) return { applied: true, outcome: { kind: 'committed', output: [{ rows: [] }], records: [] }, findings: found };
			// a keyed collection's rows match on its natural key: that is the import verb's (rule 30), never an upsert (by id)
			const on = modelKey(m, c), keyed = on.length > 0;
			if (spec.scope !== undefined && !keyed) throw new BoltError('invalidSpec', 'decode', `${c}'s import scope needs a collection key`);
			// the scope's groups: what `of` says of every record (a blank row is still in scope), else the mapped rows
			const scoped = spec.scope?.of === undefined ? rows : await Promise.all(records.map((r) => body(`pipeline.${c}.spec.import.scope.of`, [r, x])));
			const where = spec.scope === undefined ? null : scopeWhere(spec.scope, scoped.filter(isObj));
			const prune = where === null ? {} : { prune: where };
			const acts = [...rows.length === 0 && !('prune' in prune) ? [] : [{ collection: c, verb: keyed ? 'import' as const : 'create' as const,
				input: keyed ? { rows, onConflict: spec.onConflict ?? 'update', ...prune } : rows }],
				...extra.map(([collection, list]) => ({ collection, verb: 'create' as const, input: list }))];
			const { outcome } = await config.engine.calls.acts({ name: `${c}.pipeline`, acts, key: caller.key, issuedAt: caller.issuedAt,
				authority: caller.authority, bindings: caller.bindings, invocationId: caller.key, from: 'server' });
			if (outcome.kind !== 'refused' && outcome.kind !== 'conflict') return { applied: true, outcome, findings: found };
			// a refusal (a guard, a lock, a grant) refuses the whole file: one finding, at its row where it names one
			// ponytail: a refusal names a row of whichever act refused; it is placed only when no related act could have
			const rec = outcome.kind === 'refused' && outcome.row !== undefined && extra.length === 0 ? records[at[outcome.row] ?? -1] : undefined;
			const message = outcome.kind === 'refused' ? outcome.message : 'Another change touched these rows; import again.';
			return { applied: false, findings: [{ row: isObj(rec) && typeof rec['row'] === 'number' ? rec['row'] : null,
				column: outcome.kind === 'refused' && extra.length === 0 ? outcome.field ?? '' : '', message, severity: 'refuse' }] };
		},

		/** The import's sheet: the header (each list field's label, else its name; `row` is the sheet's own) and the `template` rows. */
		async template(c: string, caller: Caller, given?: Json): Promise<Cell[][]> {
			const spec = feed(c, 'import'), list = sheetList(spec.input);
			if (list === null) throw new BoltError('unsupported', 'decode', `${c}'s import input has no single list of objects to make a sheet of`);
			const fields = Object.entries(list.of).filter(([f]) => f !== 'row');
			const rows = spec.template === undefined ? [] : await mappingBody(config, caller.authority, caller.bindings, caller.key)(`pipeline.${c}.spec.import.template`,
				[{ $ctx: true }, { context: contextOf(c, spec, given) }]);
			return [fields.map(([f, k]) => headerOf(f, k)), ...(Array.isArray(rows) ? rows : []).filter(isObj).map((r) => fields.map(([f]) => cellOf(untag(r[f] ?? null))))];
		},

		/** Every row the caller may read, the declared fields only, masked as the caller sees them. */
		async export(c: string, caller: Pick<Caller, 'authority' | 'bindings'>): Promise<{ file: Blob; name: string } | FacilityError> {
			const spec = feed(c, 'export');
			const read = ir.read(catalogOf(m), c, { all: true, select: Object.fromEntries(spec.select.map((f) => [f, true])), ...(spec.where === undefined ? {} : { where: spec.where }) });
			const [res] = await config.engine.read([read], { as: 'caller', authority: caller.authority }, caller.bindings);
			const rows = (res as { rows: readonly Obj[] }).rows;
			const name = `${c}-${caller.bindings.today}.${spec.format}`;
			const table = [spec.select, ...rows.map((r) => spec.select.map((f) => untag(r[f] ?? null)))];
			const bytes = spec.format === 'xlsx' ? xlsxOf(table.map((r) => r.map(cellOf)))
				: new TextEncoder().encode(spec.format === 'json' ? JSON.stringify(rows.map((r) => Object.fromEntries(spec.select.map((f) => [f, untag(r[f] ?? null)])))) : csv(table));
			return store(name, bytes, MIME[spec.format]);
		},
	};
	async function store(name: string, bytes: Uint8Array, mime: string): Promise<{ file: Blob; name: string } | FacilityError> {
		if (bytes.byteLength > LIMITS.storedFileBytes) throw new BoltError('tooLarge', 'deliver', `${name} is over ${LIMITS.storedFileBytes} bytes`);
		const file = await callPort('files', config.files, LIMITS.callMs.other, (p, signal) => p.put(bytes, { name, mime }, signal));
		return 'kind' in file ? file : { file, name };
	}
	/** The page's context decoded against the feed's `context` fields: an input like any, never an authority. */
	function contextOf(c: string, spec: ImportData, given: Json | undefined): Json {
		const value = given ?? {};
		const d = decodeInput(spec.context ?? {}, value);
		if (d.problems.length > 0) throw new BoltError('invalidInput', 'decode', `${c}'s import context: ${d.problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join('; ')}`);
		return value;
	}
	const fail = (e: { message?: string; reason?: string }) => new BoltError('upstream', 'facility', e.message ?? e.reason ?? 'the files port failed');
	/** One `<c>.pipeline` run as its starter. The import file is the member's own upload to `<c>.$import`; an export is stored as `<c>.$export`. */
	async function run(c: string, input: Json, r: { id: string; starter: Holder | null }): Promise<Json> {
		const member = r.starter?.actor.kind === 'member' ? r.starter.actor.id : null;
		if (r.starter === null || member === null) throw new BoltError('noTrigger', 'admission', 'a pipeline run is started by a member');
		const caller: Caller = { authority: config.engine.authority(r.starter), bindings: config.bindings(), key: r.id, issuedAt: config.bindings().now };
		const x = isObj(input) ? input : {};
		if (x['mode'] === 'export' || x['mode'] === 'template') {
			const out = x['mode'] === 'export' ? await feeds.export(c, caller) : await store(`${c}-template.xlsx`, xlsxOf(await feeds.template(c, caller, x['context'])), MIME.xlsx);
			if (!('file' in out)) throw fail(out);
			const ref = { id: crypto.randomUUID(), name: out.name, mime: out.file.mime, bytes: out.file.bytes, sha256: out.file.sha256 };
			await config.engine.db.write({ text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)`, params: [ref.id, ref.name, ref.mime, ref.bytes, out.file.key, ref.sha256, `${c}.$export`, caller.issuedAt, member] });
			return { file: ref };
		}
		const [f] = await config.engine.db.read([{ text: `SELECT key, name, mime FROM sys_file WHERE id = $1 AND field = $2 AND created_by = $3`, params: [String(x['file'] ?? ''), `${c}.$import`, member] }]);
		const key = f!.rows[0]?.['key'];
		if (typeof key !== 'string') throw new BoltError('notFound', 'admission', 'The import file is not found or not yours.');
		const bytes = await callPort('files', config.files, LIMITS.callMs.other, (p, signal) => p.get(key, LIMITS.storedFileBytes, signal));
		if (!(bytes instanceof Uint8Array)) throw fail(bytes);
		const spec = feed(c, 'import');
		const sheet = f!.rows[0]?.['mime'] === MIME.xlsx || String(f!.rows[0]?.['name'] ?? '').toLowerCase().endsWith('.xlsx');
		let body: Json, findings: Finding[] = [];
		if (sheet) {
			let cells: Cell[][];
			try { cells = xlsxCells(bytes); } catch { throw new BoltError('invalidInput', 'decode', 'The import file is not an xlsx workbook.'); }
			({ input: body, findings } = fromSheet(spec.input, cells));
			if (findings.length > 0) return { applied: false, findings };
		} else try { body = JSON.parse(new TextDecoder().decode(bytes)) as Json; } catch { throw new BoltError('invalidInput', 'decode', 'The import file is neither JSON nor xlsx.'); }
		const d = decodeInput(spec.input, body);
		if (d.problems.length > 0) {
			if (!sheet) throw new BoltError('invalidInput', 'decode', d.problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join('; '));
			return { applied: false, findings: d.problems.map((p) => problemFinding(spec.input, body, p)) };
		}
		const r2 = await feeds.import(c, body, caller, { accept: x['accept'] === true, ...(x['context'] === undefined ? {} : { context: x['context'] }) });
		if (!r2.applied) return { applied: false, findings: r2.findings };
		const o = r2.outcome;
		if (o.kind === 'pendingApproval') return { pendingApproval: true };
		if (o.kind !== 'committed') throw new BoltError(o.kind, 'commit', `The import ended ${o.kind}.`);
		const main = Array.isArray(o.output) ? o.output[0] : null;
		const actions = (isObj(main) && Array.isArray(main['rows']) ? main['rows'] : []).filter(isObj).map((r) => r['action']);
		const count = (a: string) => actions.filter((x) => x === a).length;
		return { applied: true, created: Array.isArray(main) ? main.length : count('created'), updated: count('updated'), deleted: count('deleted'), findings: r2.findings };
	}
	return {
		...feeds,
		/** The platform runs `<c>.pipeline`, for the runs area's `platform` map (rule 48). */
		handlers: (): { [name: string]: Handler } => Object.fromEntries(Object.keys(m.pipelines ?? {}).map((c) => [`${c}.pipeline`, (input: Json, r: Parameters<Handler>[1]) => run(c, input, r)])),
	};
}

/** RFC 4180: a field with a comma, quote or line break is quoted, quotes doubled. */
export const csv = (rows: readonly (readonly Json[])[]): string => rows.map((r) => r.map((v) => {
	const s = v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
	return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}).join(',')).join('\r\n');

const MIME = { csv: 'text/csv', json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as const;
const cellOf = (v: Json): Cell => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v);
const findingsOf = (v: Json): Finding[] => (Array.isArray(v) ? v : []).filter(isObj).map((f) => ({ row: typeof f['row'] === 'number' ? f['row'] : null,
	column: String(f['column'] ?? ''), message: String(f['message'] ?? ''), severity: f['severity'] === 'warn' ? 'warn' : 'refuse' }));
/** The input's one list of objects: what an xlsx upload fills and a template lays out. */
function sheetList(spec: InputSpec | undefined): { field: string; of: InputSpec } | null {
	const lists = Object.entries(spec ?? {}).filter(([, k]) => k.kind === 'list' && (k['of'] as Kind | undefined)?.kind === 'object');
	return lists.length === 1 ? { field: lists[0]![0], of: (lists[0]![1]['of'] as Kind)['fields'] as InputSpec } : null;
}
const headerOf = (name: string, k: Kind) => typeof k['label'] === 'string' ? k['label'] : name;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
/** A sheet cell as the field's kind takes it: numbers and booleans as such, an Excel date or time serial in its text, the rest as text. */
function valueOf(k: Kind, c: Exclude<Cell, null>): Json {
	const text = typeof c === 'string' ? c.trim() : String(c);
	if (k.kind === 'int' || k.kind === 'number') return typeof c === 'number' ? c : text !== '' && Number.isFinite(Number(text)) ? Number(text) : text;
	if (k.kind === 'bool') return typeof c === 'boolean' ? c : /^(true|yes|y|1)$/i.test(text) ? true : /^(false|no|n|0)$/i.test(text) ? false : text;
	if (k.kind === 'date' && typeof c === 'number') return new Date(EXCEL_EPOCH + Math.floor(c) * 86_400_000).toISOString().slice(0, 10);
	if (k.kind === 'time' && typeof c === 'number') { const m = Math.round((c % 1) * 1440); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
	return text;
}
/** An xlsx sheet as the import's input: header row 1 names the list's fields (name or label, any case); blank cells and rows are left out; unknown columns are ignored. */
function fromSheet(spec: InputSpec | undefined, cells: readonly (readonly Cell[])[]): { input: Json; findings: Finding[] } {
	const list = sheetList(spec);
	if (list === null) throw new BoltError('unsupported', 'decode', 'This import takes JSON: its input has no single list of objects to read a sheet into.');
	const names = new Map(Object.entries(list.of).flatMap(([f, k]) => [[f.toLowerCase(), f], [headerOf(f, k).toLowerCase(), f]] as const));
	const columns = (cells[0] ?? []).map((h) => names.get(h === null ? '' : String(h).trim().toLowerCase()));
	const missing = Object.entries(list.of).filter(([f, k]) => f !== 'row' && k.optional !== true && k.default === undefined && !columns.includes(f));
	if (missing.length > 0) return { input: null, findings: missing.map(([f, k]) => ({ row: 1, column: headerOf(f, k), message: 'The sheet has no such column.', severity: 'refuse' })) };
	const items: Obj[] = [];
	cells.forEach((line, i) => {
		if (i === 0) return;
		const item: { [f: string]: Json } = {};
		columns.forEach((f, x) => { const c = line[x]; if (f !== undefined && f !== 'row' && c !== null && c !== undefined && !(typeof c === 'string' && c.trim() === '')) item[f] = valueOf(list.of[f]!, c); });
		if (Object.keys(item).length === 0) return;
		if (list.of['row']?.kind === 'number') item['row'] = i + 1;
		items.push(item);
	});
	return { input: { [list.field]: items }, findings: [] };
}
/** A decode problem at `<list>.<i>.<field>` as a finding on that sheet row and column. */
function problemFinding(spec: InputSpec | undefined, input: Json, p: { path: string; message: string }): Finding {
	const list = sheetList(spec), [field, i, f] = p.path.split('.');
	const item = list !== null && field === list.field && isObj(input) && Array.isArray(input[field]) ? input[field][Number(i)] : undefined;
	const k = f === undefined ? undefined : list?.of[f];
	return { row: isObj(item) && typeof item['row'] === 'number' ? item['row'] : null, column: k === undefined ? p.path : headerOf(f!, k), message: p.message, severity: 'refuse' };
}
/** A scope's `Where`: per distinct `by` values among the rows, from their first to their last `range` value. */
function scopeWhere(scope: { by: readonly string[]; range?: string }, rows: readonly Obj[]): Json | null {
	const groups = new Map<string, { by: { [f: string]: Json }; lo?: Json; hi?: Json }>();
	const less = (a: Json, b: Json) => typeof a === 'number' && typeof b === 'number' ? a < b : String(a) < String(b);
	for (const r of rows) {
		const by = Object.fromEntries(scope.by.map((f) => [f, untag(r[f] ?? null)]));
		const key = JSON.stringify(by), g = groups.get(key) ?? { by };
		groups.set(key, g);
		const v = scope.range === undefined ? null : untag(r[scope.range] ?? null);
		if (v === null) continue;
		if (g.lo === undefined || less(v, g.lo)) g.lo = v;
		if (g.hi === undefined || less(g.hi, v)) g.hi = v;
	}
	if (groups.size === 0) return null;
	return { or: [...groups.values()].map((g) => ({ and: [...scope.by.map((f) => ({ [f]: g.by[f] === null ? { isNull: true } : { eq: g.by[f]! } })),
		...(scope.range === undefined || g.lo === undefined ? [] : [{ [scope.range]: { gte: g.lo, lte: g.hi! } }])] })) };
}
