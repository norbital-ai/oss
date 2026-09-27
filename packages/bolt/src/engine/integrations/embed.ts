// `search.semantic` embeddings (rule 16): a write that creates a row, or sets one of its semantic source fields, nulls
// the row's platform embedding and queues the platform run `bolt.embed` in its own statement; the run embeds every row
// whose vector is missing through the host's `embeddings` port, after commit, never inside a write.
import { DEFAULT_EMBEDDING_DIM } from '../schema/ddl.ts';
import type { Json } from '../../decl/values.ts';
import { BoltError, callPort, LIMITS, type EmbedInput, type EmbeddingsPort, type EngineManifest, type FilesPort, type QueuedRun, type TenantDb } from '../contracts.ts';
import { q } from '../../protocol/catalog.ts';
import type { Write } from '../write/commit.ts';

export const EMBED = 'bolt.embed';
const COLUMN = 'bolt_embedding';
const PAGE = 100;
/** Rule 72: the queue's 10,000 ids per run; past it the run queues one continuation (rule 25a). */
const RUN_IDS = 10_000;

const semanticOf = (m: EngineManifest, c: string) => m.models[c]?.search?.semantic;

/**
 * The act's part (hook:write): an update naming a semantic source field also nulls the embedding; a create's is null
 * already. `stale`: some written row needs a vector, so the statement queues `embedQueued`.
 */
export function embedWrites(m: EngineManifest, writes: readonly Write[]): { writes: readonly Write[]; stale: boolean } {
	let stale = false;
	const out = writes.map((w): Write => {
		const sem = semanticOf(m, w.collection);
		if (sem === undefined) return w;
		if (w.op === 'create') { stale = true; return w; }
		if (w.op !== 'update' || !sem.fields.some((f) => f in w.set)) return w;
		stale = true;
		return { ...w, set: { ...w.set, [COLUMN]: null } };
	});
	return { writes: out, stale };
}
export const embedQueued = (id: string, now: string): QueuedRun & { id: string } => ({ id, automation: EMBED, input: {}, dueAt: now, cause: 'updated', depth: 0 });

/**
 * The platform run: every semantic collection's rows with no vector, a page at a time, one `embed` call per page. A
 * row that changed after it was read keeps its null (its own write queued the next run). A port failure fails the
 * run with the facility's kind (`upstream`/`timeout` retry, rule 54). Rule 25a: a page whose guarded write stores 0 of
 * its rows stops the run `noProgress`; after 10,000 rows the run queues one continuation and ends. A row whose `file`
 * source holds an image embeds that image (its bytes from the files port); every other row embeds its text sources.
 * ponytail: one vector per row, so the first image wins over the text; a non-image file is not embedded.
 */
export function embedRun(m: EngineManifest, db: TenantDb, port: EmbeddingsPort | undefined,
	queue: { now(): string; announce(at: string): void } = { now: () => new Date().toISOString(), announce: () => {} }, files?: FilesPort): (input: Json) => Promise<Json> {
	return async () => {
		let embedded = 0, selected = 0;
		for (const [c, spec] of Object.entries(m.models)) {
			const sem = spec.search?.semantic;
			if (sem === undefined) continue;
			const fields = sem.fields.filter((f) => spec.fields[f]?.kind !== 'file');
			const fileFields = sem.fields.filter((f) => spec.fields[f]?.kind === 'file');
			const sources = sem.fields.map((f) => `${q(f)}::text`);
			for (let after = ''; ;) {
				if (selected >= RUN_IDS) {
					const at = queue.now();
					await db.write({ text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES (gen_random_uuid()::text, $1, '{}'::jsonb, $2::timestamptz, 'continue', 0)`,
						params: [EMBED, at] });
					queue.announce(at);
					return { embedded, continued: true };
				}
				const [page] = await db.read([{ text: `SELECT id::text AS id, revision${[...fields.map((f) => `, ${q(f)}::text AS ${q(f)}`), ...fileFields.map((f) => `, ${q(f)}`)].join('')}
					FROM ${q(c)} WHERE ${q(COLUMN)} IS NULL AND id::text > $1
					AND ${sources.map((x) => `coalesce(${x}, '')`).join(' || ') || "''"} <> '' ORDER BY id::text LIMIT ${PAGE}`, params: [after] }]);
				const rows = page!.rows;
				if (rows.length === 0) break;
				after = String(rows.at(-1)!['id']);
				selected += rows.length;
				const image = (r: { readonly [k: string]: unknown }) => fileFields.flatMap((f) => [r[f] ?? []].flat() as { id?: unknown; mime?: unknown }[])
					.find((ref) => typeof ref.mime === 'string' && ref.mime.startsWith('image/'))?.id as string | undefined;
				const picked = rows.map((r) => ({ id: String(r['id']), revision: Number(r['revision']), file: image(r),
					text: fields.map((f) => r[f]).filter((v) => typeof v === 'string' && v !== '').join('\n') }));
				const stored = await imageInputs(db, files, picked.flatMap((r) => r.file === undefined ? [] : [r.file]));
				const todo = picked.flatMap((r) => { const input: EmbedInput | undefined = (r.file === undefined ? undefined : stored.get(r.file)) ?? (r.text === '' ? undefined : r.text);
					return input === undefined ? [] : [{ ...r, input }]; });
				if (todo.length === 0) continue;
				const vectors = await callPort('embeddings', port, LIMITS.callMs.ai, (p, signal) => p.embed(todo.map((r) => r.input), sem.model, signal, sem.dim ?? DEFAULT_EMBEDDING_DIM),
					(v): v is readonly (readonly number[])[] => Array.isArray(v) && v.length === todo.length);
				if ('kind' in vectors) throw new BoltError(vectors.kind, 'facility', 'message' in vectors ? vectors.message : vectors.reason);
				const set = todo.map((r, i) => ({ id: r.id, revision: r.revision, e: JSON.stringify(vectors[i]) }));
				const res = await db.write({ text: `UPDATE ${q(c)} t SET ${q(COLUMN)} = v.e::vector FROM jsonb_to_recordset($1::jsonb) AS v(id text, revision int, e text)
					WHERE t.id::text = v.id AND t.revision = v.revision AND t.${q(COLUMN)} IS NULL RETURNING t.id`, params: [set as unknown as Json] });
				if (res.rows.length === 0)
					throw new BoltError('noProgress', 'commit', `bolt.embed: a pass on ${c} selected ${todo.length} rows and wrote 0; the run stops (rule 25a)`);
				embedded += res.rows.length;
			}
		}
		return { embedded };
	};
}

/** The `sys_file` rows and bytes of the images a page embeds (≤ `LIMITS.storedFileBytes` each). A missing row or files port skips the image. */
async function imageInputs(db: TenantDb, files: FilesPort | undefined, ids: readonly string[]): Promise<Map<string, EmbedInput>> {
	const out = new Map<string, EmbedInput>();
	if (ids.length === 0 || files === undefined) return out;
	const [res] = await db.read([{ text: `SELECT id, name, mime, key, sha256 FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`, params: [ids as unknown as Json] }]);
	for (const f of res!.rows) {
		const bytes = await files.get(String(f['key']), LIMITS.storedFileBytes, AbortSignal.timeout(LIMITS.callMs.other))
			.catch((e: unknown) => { throw new BoltError('upstream', 'facility', e instanceof Error ? e.message : 'a file could not be read'); });
		out.set(String(f['id']), { $file: { name: String(f['name']), mime: String(f['mime']), sha256: String(f['sha256']), bytes } });
	}
	return out;
}
