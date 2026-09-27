// Pipelines (§3.3.5, rule 30): a collection's recurring import and export feeds. An import's rows enter through the
// collection's write pipeline as the caller, in one act (upsert on a keyed collection, else create); an export is
// `read({ all: true })` under the caller's scope and masks, encoded and stored as a file. From the browser each is a run of
// the platform automation `<c>.pipeline` (input `{ mode: 'import', file } | { mode: 'export' }`), started as its caller
// (the run's `starter`), so `RunStatus` shows it and an export's `FileRef` is the run's output.
import type { Json } from '../../decl/values.ts';
import type { FacilityError } from '../../decl/runtime/facilities.ts';
import type { Holder } from '../access/authority.ts';
import type { Authority, Bindings, Blob, FilesPort, GuestPort, Outcome } from '../contracts.ts';
import { BoltError, callPort, LIMITS } from '../contracts.ts';
import { catalogOf } from '../access/pred.ts';
import { decodeInput, type InputSpec } from '../callables/decode.ts';
import type { Engine } from '../index.ts';
import { mappingBody } from '../integrations/runner.ts';
import * as ir from '../../protocol/ir.ts';
import { upsertKey } from '../write/flatten.ts';
import { untag } from '../write/sql.ts';

type ImportData = { onConflict?: 'update' | 'keep'; known?: unknown; input?: InputSpec };
type ExportData = { select: readonly string[]; where?: object; format: 'csv' | 'xlsx' | 'json' };
export type PipelinesConfig = { engine: Pick<Engine, 'manifest' | 'act' | 'read' | 'db' | 'authority'>; bindings: () => Bindings; guest?: GuestPort; files?: FilesPort };
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
		 * `records(input)`, then `known(ctx, keys)` over the records' key values (the collection's single-field key), then
		 * `map(record, { known })` per record (`null` skips it). `known` reaches `map` as an object by key value.
		 */
		async import(c: string, input: Json, caller: Caller): Promise<Outcome> {
			const spec = feed(c, 'import');
			const body = mappingBody(config, caller.authority, caller.bindings, caller.key);
			const records = await body(`pipeline.${c}.spec.import.records`, [input]);
			if (!Array.isArray(records)) throw new BoltError('invalidRecords', 'guest', 'an import\'s records returns a list');
			const on = upsertKey(m, c), field = on.length === 1 ? on[0]! : undefined;
			let known: Obj = {};
			if (spec.known !== undefined && field !== undefined) {
				const keys = records.flatMap((r) => isObj(r) && r[field] !== null && r[field] !== undefined ? [String(r[field])] : []);
				const rows = await body(`pipeline.${c}.spec.import.known`, [{ $ctx: true }, keys]);
				known = Object.fromEntries((Array.isArray(rows) ? rows : []).filter(isObj).map((r) => [String(r[field]), r]));
			}
			const rows: Json[] = [];
			for (const record of records) {
				const row = await body(`pipeline.${c}.spec.import.map`, [record, { known }]);
				if (row !== null) rows.push(row);
			}
			if (rows.length === 0) return { kind: 'committed', output: [], records: [] };
			const keyed = on.length > 0;
			return (await config.engine.act({ collection: c, verb: keyed ? 'upsert' : 'create', input: rows, key: caller.key, issuedAt: caller.issuedAt,
				authority: caller.authority, bindings: caller.bindings, invocationId: caller.key,
				...(keyed ? { onConflict: spec.onConflict ?? 'update' } : {}) })).outcome;
		},

		/** Every row the caller may read, the declared fields only, masked as the caller sees them. */
		async export(c: string, caller: Pick<Caller, 'authority' | 'bindings'>): Promise<{ file: Blob; name: string } | FacilityError> {
			const spec = feed(c, 'export');
			const read = ir.read(catalogOf(m), c, { all: true, select: Object.fromEntries(spec.select.map((f) => [f, true])), ...(spec.where === undefined ? {} : { where: spec.where }) });
			const [res] = await config.engine.read([read], { as: 'caller', authority: caller.authority }, caller.bindings);
			const rows = (res as { rows: readonly Obj[] }).rows;
			const name = `${c}-${caller.bindings.today}.${spec.format}`;
			if (spec.format === 'xlsx') throw new BoltError('unsupported', 'deliver', 'xlsx export needs std/sheet, which this host lacks'); // ponytail: std/sheet
			const text = spec.format === 'json' ? JSON.stringify(rows.map((r) => Object.fromEntries(spec.select.map((f) => [f, untag(r[f] ?? null)]))))
				: csv([spec.select, ...rows.map((r) => spec.select.map((f) => untag(r[f] ?? null)))]);
			const bytes = new TextEncoder().encode(text);
			if (bytes.byteLength > LIMITS.storedFileBytes) throw new BoltError('tooLarge', 'deliver', `the export is over ${LIMITS.storedFileBytes} bytes`);
			const file = await callPort('files', config.files, LIMITS.callMs.other, (p, signal) =>
				p.put(bytes, { name, mime: spec.format === 'json' ? 'application/json' : 'text/csv' }, signal));
			return 'kind' in file ? file : { file, name };
		},
	};
	const fail = (e: { message?: string; reason?: string }) => new BoltError('upstream', 'facility', e.message ?? e.reason ?? 'the files port failed');
	/** One `<c>.pipeline` run as its starter. The import file is the member's own upload to `<c>.$import`; an export is stored as `<c>.$export`. */
	async function run(c: string, input: Json, r: { id: string; starter: Holder | null }): Promise<Json> {
		const member = r.starter?.actor.kind === 'member' ? r.starter.actor.id : null;
		if (r.starter === null || member === null) throw new BoltError('noTrigger', 'admission', 'a pipeline run is started by a member');
		const caller: Caller = { authority: config.engine.authority(r.starter), bindings: config.bindings(), key: r.id, issuedAt: config.bindings().now };
		const x = isObj(input) ? input : {};
		if (x['mode'] === 'export') {
			const out = await feeds.export(c, caller);
			if (!('file' in out)) throw fail(out);
			const ref = { id: crypto.randomUUID(), name: out.name, mime: out.file.mime, bytes: out.file.bytes, sha256: out.file.sha256 };
			await config.engine.db.write({ text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)`, params: [ref.id, ref.name, ref.mime, ref.bytes, out.file.key, ref.sha256, `${c}.$export`, caller.issuedAt, member] });
			return { file: ref };
		}
		const [f] = await config.engine.db.read([{ text: `SELECT key FROM sys_file WHERE id = $1 AND field = $2 AND created_by = $3`, params: [String(x['file'] ?? ''), `${c}.$import`, member] }]);
		const key = f!.rows[0]?.['key'];
		if (typeof key !== 'string') throw new BoltError('notFound', 'admission', 'The import file is not found or not yours.');
		const bytes = await callPort('files', config.files, LIMITS.callMs.other, (p, signal) => p.get(key, LIMITS.storedFileBytes, signal));
		if (!(bytes instanceof Uint8Array)) throw fail(bytes);
		let body: Json;
		try { body = JSON.parse(new TextDecoder().decode(bytes)) as Json; } catch { throw new BoltError('invalidInput', 'decode', 'The import file is not JSON.'); } // ponytail: JSON only; CSV when a feed's input is one flat list
		const d = decodeInput(feed(c, 'import').input, body);
		if (d.problems.length > 0) throw new BoltError('invalidInput', 'decode', d.problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join('; '));
		const o = await feeds.import(c, body, caller);
		if (o.kind === 'committed') return { imported: o.records.length };
		if (o.kind === 'pendingApproval') return { pendingApproval: true };
		throw new BoltError(o.kind === 'refused' ? o.code : o.kind, 'commit', o.kind === 'refused' ? o.message : `The import ended ${o.kind}.`);
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
