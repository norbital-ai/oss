// `ctx.files.{meta,get,url,put,image,text,table,sheet}` in automations (§5.8.1): the engine's own answer over the host's
// files port and the `sys_file` rows (rule 18), for any host that stores blobs. A read names a file the run's `runAs` may
// read (a field it reads, or a file its own automation or one it holds stored); bytes cross beside the JSON as
// `{ "$bin": 0 }`. Images decode in a bounded worker (image-worker.ts); `pdf` and `render` stay the host's.
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { Json } from '../../decl/values.ts';
import { sizeBytes } from '../callables/upload.ts';
import type { CrossAnswer, CrossCall, EngineManifest, FilesPort, TenantDb } from '../contracts.ts';
import { LIMITS } from '../contracts.ts';
import { PATHS } from '../../protocol/wire.ts';
import { xlsxCells, xlsxSheets } from '../agent/xlsx.ts';

export const FILE_METHODS = new Set(['meta', 'get', 'url', 'put', 'image', 'text', 'table', 'sheet']);
type Row = { id: string; name: string; mime: string; size: number; key: string; sha256: string; field: string };
const invalid = (message: string): CrossAnswer => ({ ok: false, error: { kind: 'invalid', message } });
const refOf = (r: Row): Json => ({ id: r.id, name: r.name, mime: r.mime, bytes: Number(r.size), sha256: r.sha256 });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TEXT = /^(text\/|application\/(json|xml|csv)\b)/;
const isXlsx = (f: Row) => f.mime === XLSX || f.name.toLowerCase().endsWith('.xlsx');

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF rows; a trailing newline adds no row. */
function csvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [], cell = '', quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') { row.push(cell); cell = ''; }
		else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
		else cell += ch;
	}
	if (cell !== '' || row.length > 0) rows.push([...row, cell]);
	return rows;
}

/** One image job in a worker under the image wall and a heap cap, so a hostile file cannot stall or exhaust the host. */
export function imageJob(bytes: Uint8Array, maxEdge: number | undefined, signal: AbortSignal): Promise<Json | Uint8Array> {
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(LIMITS.callMs.image)]);
	// a concatenated specifier, so a bundler's worker and asset plugins leave the URL alone
	const script = new URL('./image-worker' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'), import.meta.url);
	const worker = new Worker(script, { workerData: { bytes, maxEdge }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
	return new Promise<Json | Uint8Array>((resolve, reject) => {
		const abort = () => reject(new Error(`the image was not read within ${LIMITS.callMs.image / 1000} s`));
		bounded.addEventListener('abort', abort, { once: true });
		worker.once('message', resolve);
		worker.once('error', reject);
		worker.once('exit', () => reject(new Error('the image worker ended without an answer')));
		if (bounded.aborted) abort();
	}).finally(() => void worker.terminate());
}

export function runFiles(o: { manifest: EngineManifest; db: TenantDb; files: FilesPort; automation: string; now: string;
	/** Whether the run may read a file held in `field` (`'<collection>.<field>'` or an automation name). */
	readable(id: string, field: string): Promise<boolean> }) {
	const row = async (ref: Json): Promise<Row | CrossAnswer> => {
		const id = ref !== null && typeof ref === 'object' && !Array.isArray(ref) ? (ref as { readonly [k: string]: Json })['id'] : undefined;
		if (typeof id !== 'string') return invalid('a FileRef names its id');
		const [r] = await o.db.read([{ text: `SELECT id, name, mime, size, key, sha256, field FROM sys_file WHERE id = $1`, params: [id] }]);
		const f = r!.rows[0] as unknown as Row | undefined;
		if (f === undefined || !await o.readable(id, f.field)) return invalid(`this run cannot read file ${id}`);
		return f;
	};
	return async (call: Extract<CrossCall, { op: 'facility' }>, signal: AbortSignal): Promise<CrossAnswer> => {
		const [first = null, options = null] = call.args;
		if (call.method === 'put') {
			const bytes = call.bins?.[0], meta = (options ?? {}) as { name?: unknown; mime?: unknown; for?: unknown };
			if (bytes === undefined) return invalid('files.put takes bytes');
			if (bytes.byteLength > LIMITS.fileBytes) return { ok: false, error: { kind: 'tooLarge', message: `files.put takes at most ${LIMITS.fileBytes} bytes` } };
			if (typeof meta.name !== 'string' || typeof meta.mime !== 'string' || typeof meta.for !== 'string') return invalid('files.put takes { name, mime, for }');
			const [c, f] = meta.for.split('.');
			const owner = f === undefined ? o.manifest.automations[meta.for] !== undefined : (o.manifest.models[c!]?.fields[f] as { kind?: string } | undefined)?.kind === 'file';
			if (!owner) return invalid(`files.put: '${meta.for}' is no file field and no automation`);
			const blob = await o.files.put(bytes, { name: meta.name, mime: meta.mime }, signal);
			const r: Row = { id: crypto.randomUUID(), name: meta.name, mime: meta.mime, size: bytes.byteLength, key: blob.key,
				sha256: createHash('sha256').update(bytes).digest('hex'), field: meta.for };
			await o.db.write({ text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
				params: [r.id, r.name, r.mime, r.size, r.key, r.sha256, r.field, o.now] });
			return { ok: true, value: refOf(r) };
		}
		const f = await row(first);
		if ('ok' in f) return f;
		if (call.method === 'meta') return { ok: true, value: refOf(f) };
		if (['image', 'text', 'table', 'sheet'].includes(call.method)) {
			const bytes = await o.files.get(f.key, LIMITS.storedFileBytes, signal);
			if (call.method === 'image') {
				const jpeg = (options as { jpeg?: { maxEdge?: unknown } } | null)?.jpeg;
				if (jpeg === undefined) {
					const facts = await imageJob(bytes, undefined, signal) as { readonly [k: string]: Json };
					return { ok: true, value: { ...facts, sha256: createHash('sha256').update(bytes).digest('hex') } };
				}
				const edge = jpeg?.maxEdge;
				if (typeof edge !== 'number' || !Number.isInteger(edge) || edge < 16 || edge > 8192) return invalid('files.image takes { jpeg: { maxEdge: 16..8192 } }');
				const derived = await imageJob(bytes, edge, signal) as Uint8Array;
				const name = `${f.name.replace(/\.[^./]*$/, '')}.jpg`, blob = await o.files.put(derived, { name, mime: 'image/jpeg' }, signal);
				const r: Row = { id: crypto.randomUUID(), name, mime: 'image/jpeg', size: derived.byteLength, key: blob.key,
					sha256: createHash('sha256').update(derived).digest('hex'), field: o.automation };
				await o.db.write({ text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
					params: [r.id, r.name, r.mime, r.size, r.key, r.sha256, r.field, o.now] });
				return { ok: true, value: refOf(r) };
			}
			// an xlsx: `sheet` is every worksheet by its own name (a scheduling workbook's Settings, Roster, Time entries…),
			// `table` its first
			if (call.method !== 'text' && isXlsx(f)) {
				if (call.method === 'sheet') return { ok: true, value: xlsxSheets(bytes).map((name, n) => ({ name, rows: xlsxCells(bytes, n) })) as Json };
				return { ok: true, value: xlsxCells(bytes).map((r) => r.map((c) => c === null ? '' : String(c))) };
			}
			if (!TEXT.test(f.mime)) return invalid(`files.${call.method} reads text${call.method === 'text' ? '' : ', CSV or xlsx'}; ${f.name} is ${f.mime}`);
			let text: string;
			try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return invalid(`${f.name} is not UTF-8 text`); }
			if (call.method === 'text') return { ok: true, value: text };
			const rows = csvRows(text);
			return { ok: true, value: call.method === 'sheet' ? [{ name: f.name, rows }] : rows };
		}
		if (call.method === 'url') {
			// ponytail: a store without signed URLs (local files) answers the files route, served to viewers who may read it
			const url = await o.files.url(f.key, 3_600, signal).catch(() => `${PATHS.files}${encodeURIComponent(f.id)}`);
			return { ok: true, value: url };
		}
		const asked = (options as { max?: unknown } | null)?.max;
		const max = Math.min(typeof asked === 'number' ? asked : typeof asked === 'string' ? sizeBytes(asked) : LIMITS.fileBytes, LIMITS.fileBytes);
		if (Number.isNaN(max)) return invalid(`files.get: max '${String(asked)}' is no size`);
		if (Number(f.size) > max) return { ok: false, error: { kind: 'tooLarge', message: `${f.name} holds ${f.size} bytes; files.get reads at most ${max}` } };
		return { ok: true, value: { $bin: 0 }, bins: [await o.files.get(f.key, max, signal)] };
	};
}
