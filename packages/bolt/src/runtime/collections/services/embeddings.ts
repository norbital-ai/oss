import { Effect, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { sha256Text } from '@norbital-ai/std/reckon/hash';
import {
	EMBEDDED_AT_COLUMN,
	RECORD_EMBEDDING_COLUMN,
	RECORD_EMBEDDING_FINGERPRINT_COLUMN
} from '#lib/authoring/model-introspection.js';
import type * as Database from '#lib/runtime/facilities/database.js';
import type { AIInterface } from '#lib/runtime/facilities/services.js';
import { encodeBase64 } from '#lib/runtime/collections/file-assets.js';

type EmbeddingCollection = Readonly<{
	readonly name: string;
	readonly fields: Readonly<Record<string, Readonly<{ readonly type: string }> | undefined>>;
	readonly embedding?: Readonly<{
		readonly fields: ReadonlyArray<string>;
		readonly model?: string;
		readonly dimensions?: number;
	}>;
}>;

export const RECORD_EMBEDDING_BACKFILL_LIMIT = 2;
const RECORD_EMBEDDING_BATCH_ROWS = 2;

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

type EmbeddingAsset = Readonly<{
	readonly bytes: Uint8Array;
	readonly mimeType: string | null;
}>;

type EmbeddingPorts = Readonly<{
	readonly database: Pick<Database.Interface, 'execute'>;
	readonly ai: Pick<AIInterface, 'execute'>;
	readonly collections: ReadonlyArray<EmbeddingCollection>;
	readonly readAsset: (
		effectId: EffectId,
		file: Record<string, unknown>
	) => Effect.Effect<EmbeddingAsset, unknown>;
}>;

/** The content parts one record contributes to its embedding, in declared field order. */
export const recordEmbeddingParts = Effect.fn('Collections.recordEmbeddingParts')(function* (
	ports: EmbeddingPorts,
	effectId: EffectId,
	collection: EmbeddingCollection,
	row: Readonly<Record<string, unknown>>
) {
	const parts: Array<Schema.Json> = [];
	for (const name of collection.embedding?.fields ?? []) {
		const value = row[name];
		if (value === null || value === undefined) continue;
		const field = collection.fields[name];
		if (field?.type === 'json' && typeof value === 'object' && 'storage_key' in value) {
			const asset = yield* ports
				.readAsset(effectId, value as Record<string, unknown>)
				.pipe(Effect.catch(() => Effect.succeed(undefined)));
			if (asset === undefined || asset.bytes.byteLength === 0) continue;
			const base64 = encodeBase64(asset.bytes);
			parts.push({
				type: 'image_url',
				image_url: { url: `data:${asset.mimeType ?? 'image/jpeg'};base64,${base64}` }
			});
			continue;
		}
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		if (text.trim() === '') continue;
		parts.push({ type: 'text', text });
	}
	return parts;
});

/**
 * One bounded backfill pass per collection that declares an embedding.
 * Embedding maintenance is derived settle state: it must not wake a live query.
 */
export const embedRecords = Effect.fn('Collections.embedRecords')(function* (
	ports: EmbeddingPorts,
	effectId: EffectId,
	limit: number = RECORD_EMBEDDING_BACKFILL_LIMIT,
	targets?: ReadonlyMap<string, ReadonlyArray<string>>
) {
	const summary: Array<{ readonly collection: string; readonly embedded: number }> = [];
	for (const collection of ports.collections) {
		const declared = collection.embedding;
		if (declared === undefined) continue;
		const targetIds = targets?.get(collection.name);
		if (targets !== undefined && (targetIds === undefined || targetIds.length === 0)) continue;
		const fields = declared.fields.filter((name) => collection.fields[name] !== undefined);
		if (fields.length === 0) continue;
		const table = quoteIdentifier(collection.name);
		const selected = yield* ports.database.execute(effectId, {
			_tag: 'Query',
			// repository-health:allow SQL1 -- identifiers come from the compiled workspace definition.
			sql: `select "id", "updated_at", ${quoteIdentifier(RECORD_EMBEDDING_COLUMN)}, ${quoteIdentifier(RECORD_EMBEDDING_FINGERPRINT_COLUMN)}, ${fields.map(quoteIdentifier).join(', ')} from ${table} where (${quoteIdentifier(RECORD_EMBEDDING_COLUMN)} is null or ${quoteIdentifier(EMBEDDED_AT_COLUMN)} is null or ${quoteIdentifier(EMBEDDED_AT_COLUMN)} < "updated_at")${targetIds === undefined ? '' : ' and "id" = any($2::uuid[])'} order by "id" limit $1`,
			parameters: targetIds === undefined ? [limit] : [limit, targetIds]
		});
		let embedded = 0;
		for (let offset = 0; offset < selected.rows.length; offset += RECORD_EMBEDDING_BATCH_ROWS) {
			const batch = selected.rows.slice(offset, offset + RECORD_EMBEDDING_BATCH_ROWS);
			const prepared: Array<{
				readonly id: unknown;
				readonly updatedAt: unknown;
				readonly fingerprint: string;
				readonly input: Schema.Json;
			}> = [];
			const unchanged: Array<{
				readonly id: unknown;
				readonly updated_at: unknown;
				readonly fingerprint: string;
			}> = [];
			for (const row of batch) {
				const parts = yield* recordEmbeddingParts(
					ports,
					effectId,
					collection,
					row as Readonly<Record<string, unknown>>
				);
				if (parts.length === 0) continue;
				const source = Object.fromEntries(
					fields.map((field) => [field, Reflect.get(row as object, field)])
				);
				const fingerprint = `sha256:${sha256Text(JSON.stringify(source))}`;
				if (
					Reflect.get(row as object, RECORD_EMBEDDING_FINGERPRINT_COLUMN) === fingerprint &&
					Reflect.get(row as object, RECORD_EMBEDDING_COLUMN) != null
				) {
					unchanged.push({
						id: (row as { id: unknown }).id,
						updated_at: Reflect.get(row as object, 'updated_at'),
						fingerprint
					});
					continue;
				}
				prepared.push({
					id: (row as { id: unknown }).id,
					updatedAt: Reflect.get(row as object, 'updated_at'),
					fingerprint,
					input: { content: parts }
				});
			}
			if (unchanged.length > 0)
				yield* ports.database.execute(effectId, {
					_tag: 'Query',
					// A matching fingerprint proves the vector is current; advancing only the
					// observation timestamp clears staleness without waking readers or spending AI.
					sql: `update ${table} as target set ${quoteIdentifier(EMBEDDED_AT_COLUMN)} = clock_timestamp() from jsonb_to_recordset($1::jsonb) as source(id uuid, updated_at timestamptz, fingerprint text) where target."id" = source.id and target."updated_at" is not distinct from source.updated_at and target.${quoteIdentifier(RECORD_EMBEDDING_FINGERPRINT_COLUMN)} = source.fingerprint`,
					parameters: [JSON.stringify(unchanged) as Schema.Json]
				});
			if (prepared.length === 0) continue;
			const response = yield* ports.ai
				.execute(EffectId.make(`${effectId}:embedding:${collection.name}:${offset}`), {
					_tag: 'Embed',
					model: declared.model ?? 'default',
					inputs: prepared.map(({ input }) => input),
					...(declared.dimensions === undefined ? {} : { dimensions: declared.dimensions })
				})
				.pipe(Effect.catch(() => Effect.succeed(undefined)));
			const vectors = Array.isArray(response?.output)
				? (response.output as ReadonlyArray<ReadonlyArray<number>>)
				: [];
			const writable = prepared.flatMap(({ id, updatedAt, fingerprint }, position) => {
				const embedding = vectors[position];
				return embedding === undefined || embedding.length === 0
					? []
					: [{ id, updated_at: updatedAt, fingerprint, embedding }];
			});
			if (writable.length === 0) continue;
			yield* ports.database.execute(effectId, {
				_tag: 'Query',
				// repository-health:allow SQL1 -- one bound json document; the table name is compiled.
				// Embedding maintenance is derived settle state: it must not advance row version/time,
				// emit collection changes, or wake a live query.
				sql: `update ${table} as target set ${quoteIdentifier(RECORD_EMBEDDING_COLUMN)} = (source.embedding)::text::vector, ${quoteIdentifier(RECORD_EMBEDDING_FINGERPRINT_COLUMN)} = source.fingerprint, ${quoteIdentifier(EMBEDDED_AT_COLUMN)} = clock_timestamp() from jsonb_to_recordset($1::jsonb) as source(id uuid, updated_at timestamptz, fingerprint text, embedding jsonb) where target."id" = source.id and target."updated_at" is not distinct from source.updated_at`,
				parameters: [JSON.stringify(writable) as Schema.Json]
			});
			embedded += writable.length;
		}
		summary.push({ collection: collection.name, embedded });
	}
	return summary;
});
