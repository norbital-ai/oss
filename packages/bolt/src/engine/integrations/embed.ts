// `search.semantic` embeddings (rule 16): a write that creates a row, or sets one of its semantic source fields, nulls
// the row's platform embedding and queues the platform run `bolt.embed` in its own statement; the run embeds every row
// whose vector is missing through the host's `embeddings` port, after commit, never inside a write.
import { Clock, Effect, Schema } from 'effect';
import { LIMITS, type EmbedInput, type QueuedRun } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { Ai } from '../ports.ts';
import { Manifest, Wake, type RunHandler } from '../services.ts';
import { Port } from '../port.ts';
import { Chain } from '../write/sql.ts';
import { enqueue } from '../runs/queue.ts';
import { iso } from '../runs/time.ts';
import { BoltError } from '../../protocol/errors.ts';
import { q } from '@norbital-ai/store';
import type { Write } from '../write/commit.ts';

export const EMBED = 'bolt.embed';
const COLUMN = 'bolt_embedding';
const PAGE = 100;
/** Rule 72: the queue's 10,000 ids per run; past it the run queues one continuation (rule 25a). */
const RUN_IDS = 10_000;

/** A stored file reference, as much of it as the embedder reads. */
const FileLike = Schema.Struct({ id: Schema.String, mime: Schema.String });
/** One unembedded row: its semantic text fields and its file fields, each in declaration order. */
const EmbedRow = Schema.Struct({
	id: Schema.String,
	revision: Schema.Number,
	texts: Schema.Array(Schema.NullOr(Schema.String)),
	files: Schema.Array(Schema.NullOr(Schema.Union([FileLike, Schema.Array(FileLike)])))
});
const semanticOf = (m: EngineManifest, c: string) => m.models[c]?.search?.semantic;

/**
 * The act's part (hook:write): an update naming a semantic source field also nulls the embedding; a create's is null
 * already. `stale`: some written row needs a vector, so the statement queues `embedQueued`.
 */
export function embedWrites(
	m: EngineManifest,
	writes: readonly Write[]
): { writes: readonly Write[]; stale: boolean } {
	let stale = false;
	const out = writes.map((w): Write => {
		const sem = semanticOf(m, w.collection);
		if (sem === undefined) return w;
		if (w.op === 'create') {
			stale = true;
			return w;
		}
		if (w.op !== 'update' || !sem.fields.some((f) => f in w.set)) return w;
		stale = true;
		return { ...w, set: { ...w.set, [COLUMN]: null } };
	});
	return { writes: out, stale };
}
export const embedQueued = (id: string, now: string): QueuedRun & { id: string } => ({
	id,
	automation: EMBED,
	input: {},
	dueAt: now,
	cause: 'updated',
	depth: 0
});

/**
 * The widths the host answered. The model class is asked for `search.semantic.dim`; a host that ignores `dimensions` would
 * otherwise fail much later as a raw pgvector dimension error, on every stored row and every probe, so it fails here where
 * the cause is nameable.
 */
function assertWidth(
	vectors: readonly (readonly number[])[],
	sem: { readonly model: string; readonly dim: number }
): void {
	const wrong = vectors.find((v) => v.length !== sem.dim);
	if (wrong !== undefined)
		throw BoltError.make(
			'invalid',
			'facility',
			`the host's '${sem.model}' answered a ${wrong.length}-wide vector, not the ${sem.dim} it was asked for`
		);
}

/**
 * The platform run: every semantic collection's rows with no vector, a page at a time, one `embed` call per page. A
 * row that changed after it was read keeps its null (its own write queued the next run). A port failure fails the
 * run with the facility's kind (`upstream`/`timeout` retry, rule 54). Rule 25a: a page whose guarded write stores 0 of
 * its rows stops the run `noProgress`; after 10,000 rows the run queues one continuation and ends. A row whose `file`
 * source holds an image embeds that image (its bytes from the files port); every other row embeds its text sources.
 * ponytail: one vector per row, so the first image wins over the text; a non-image file is not embedded.
 */
export const embedRun = Effect.gen(function* () {
	const manifest = yield* Manifest,
		db = yield* TenantDb,
		ai = yield* Ai,
		wake = yield* Wake;
	const File = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		mime: Schema.String,
		key: Schema.String,
		size: Schema.Number,
		sha256: Schema.String
	});
	const imageInputs = (ids: readonly string[]) =>
		Effect.gen(function* () {
			const out = new Map<string, EmbedInput>();
			if (ids.length === 0) return out;
			const rows = yield* db.rows(File, {
				text: `SELECT id, name, mime, key, size, sha256 FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
				params: [JSON.stringify(ids)]
			});
			for (const row of rows) {
				out.set(row.id, {
					$stored: {
						key: row.key,
						name: row.name,
						mime: row.mime,
						sha256: row.sha256,
						bytes: row.size
					}
				});
			}
			return out;
		});
	const run: RunHandler = () =>
		Effect.gen(function* () {
			let embedded = 0,
				selected = 0;
			for (const [collection, spec] of Object.entries(manifest.models)) {
				const semantic = spec.search?.semantic;
				if (semantic === undefined) continue;
				const fields = semantic.fields.filter((field) => spec.fields[field]?.kind !== 'file'),
					fileFields = semantic.fields.filter((field) => spec.fields[field]?.kind === 'file');
				const sources = semantic.fields.map((field) => `${q(field)}::text`);
				for (let after = ''; ;) {
					if (selected >= RUN_IDS) {
						const at = iso(yield* Clock.currentTimeMillis),
							c = new Chain();
						enqueue(c, [{ automation: EMBED, input: {}, dueAt: at, cause: 'continue', depth: 0 }]);
						yield* db.write(c.sql('NULL AS outcome'));
						yield* wake.at(at);
						return { embedded, continued: true };
					}
					const rows = yield* db.rows(EmbedRow, {
						text: `SELECT id::text AS id, revision, jsonb_build_array(${fields.map((field) => `${q(field)}::text`).join(', ')}) AS texts, jsonb_build_array(${fileFields.map(q).join(', ')}) AS files FROM ${q(collection)} WHERE ${q(COLUMN)} IS NULL AND id::text > $1 AND ${sources.map((field) => `coalesce(${field}, '')`).join(' || ') || "''"} <> '' ORDER BY id::text LIMIT ${PAGE}`,
						params: [after]
					});
					const last = rows.at(-1);
					if (last === undefined) break;
					after = last.id;
					selected += rows.length;
					const picked = rows.map((row) => ({
						id: row.id,
						revision: row.revision,
						file: row.files
							.flatMap((v) => (v === null ? [] : 'id' in v ? [v] : v))
							.find((ref) => ref.mime.startsWith('image/'))?.id,
						text: row.texts.filter((value) => value !== null && value !== '').join('\n')
					}));
					const stored = yield* imageInputs(
						picked.flatMap((row) => (row.file === undefined ? [] : [row.file]))
					);
					const todo = picked.flatMap((row) => {
						const input =
							(row.file === undefined ? undefined : stored.get(row.file)) ??
							(row.text === '' ? undefined : row.text);
						return input === undefined ? [] : [{ ...row, input }];
					});
					if (todo.length === 0) continue;
					const vectors = yield* ai
						.embed(
							todo.map((row) => row.input),
							semantic.model,
							semantic.dim
						)
						.pipe(
							Port.call('embeddings', LIMITS.callMs.ai),
							Effect.mapError((error) =>
								BoltError.make(
									error._tag === 'Unavailable' ? 'unavailable' : error.kind,
									'facility',
									error._tag === 'Unavailable' ? error.reason : error.message
								)
							)
						);
					if (vectors.length !== todo.length)
						return yield* Effect.fail(
							BoltError.make(
								'badAnswer',
								'facility',
								'the host returned the wrong number of embeddings'
							)
						);
					yield* Effect.try({
						try: () => assertWidth(vectors, semantic),
						catch: (error) =>
							error instanceof BoltError
								? error
								: BoltError.make('badAnswer', 'facility', 'the host returned invalid embeddings')
					});
					const set = todo.map((row, index) => ({
						id: row.id,
						revision: row.revision,
						e: JSON.stringify(vectors[index])
					}));
					const result = yield* db.write({
						text: `UPDATE ${q(collection)} t SET ${q(COLUMN)} = v.e::vector FROM jsonb_to_recordset($1::jsonb) AS v(id text, revision int, e text) WHERE t.id::text = v.id AND t.revision = v.revision AND t.${q(COLUMN)} IS NULL RETURNING t.id`,
						params: [JSON.stringify(set)]
					});
					if (result.rows.length === 0)
						return yield* Effect.fail(
							BoltError.make(
								'noProgress',
								'commit',
								`bolt.embed: a pass on ${collection} selected ${todo.length} rows and wrote 0; the run stops (rule 25a)`
							)
						);
					embedded += result.rows.length;
				}
			}
			return { embedded };
		});
	return run;
});
