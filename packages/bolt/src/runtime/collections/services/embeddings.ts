import { Effect, Option, Schema } from 'effect';
import { AIImageAssetPart, EffectId } from '@norbital-ai/bolt-protocol';
import { sha256Text } from '@norbital-ai/std/reckon/hash';
import {
	EMBEDDED_AT_COLUMN,
	RECORD_EMBEDDING_COLUMN,
	RECORD_EMBEDDING_FINGERPRINT_COLUMN
} from '#lib/authoring/model-introspection.js';
import type * as Database from '#lib/runtime/facilities/database.js';
import type { AIInterface } from '#lib/runtime/facilities/services.js';
type EmbeddingCollection = Readonly<{
	readonly name: string;
	readonly fields: Readonly<Record<string, Readonly<{ readonly type: string }> | undefined>>;
	readonly embedding?: Readonly<{
		readonly fields: ReadonlyArray<string>;
		readonly model?: string;
		readonly dimensions?: number;
	}>;
}>;
export const RECORD_EMBEDDING_BACKFILL_LIMIT = 512; // one bounded bulk claim
const RECORD_EMBEDDING_BATCH_ROWS = 100;
// Five requests drain the largest claim. A small bound overlaps provider latency without recreating
// the old burst of dozens of eight-input requests that exhausted the provider's request quota.
const RECORD_EMBEDDING_BATCH_CONCURRENCY = 4;
const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
type EmbeddingPorts = Readonly<{
	readonly database: Pick<Database.Interface, 'execute'>;
	readonly ai: Pick<AIInterface, 'execute'>;
	readonly collections: ReadonlyArray<EmbeddingCollection>;
}>;
export const recordEmbeddingParts = Effect.fn('Collections.recordEmbeddingParts')(function* (
	ports: EmbeddingPorts,
	collection: EmbeddingCollection,
	row: Readonly<Record<string, unknown>>
) {
	const parts: Array<Schema.Json> = [];
	for (const name of collection.embedding?.fields ?? []) {
		const value = row[name];
		if (value === null || value === undefined) continue;
		if (
			collection.fields[name]?.type === 'json' &&
			typeof value === 'object' &&
			'storage_key' in value
		) {
			const asset = Schema.decodeUnknownOption(AIImageAssetPart)({
				type: 'image_asset',
				image_asset: {
					key: Reflect.get(value, 'storage_key'),
					name: Reflect.get(value, 'file_name'),
					mimeType: Reflect.get(value, 'mime_type'),
					size: Reflect.get(value, 'file_size')
				}
			});
			if (Option.isSome(asset)) parts.push(asset.value);
			continue;
		}
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		if (text.trim() === '') continue;
		parts.push({ type: 'text', text });
	}
	return parts;
});
/** One bounded backfill pass; derived embedding settlement never wakes live queries. */
export const embedRecords = Effect.fn('Collections.embedRecords')(function* (
	ports: EmbeddingPorts,
	effectId: EffectId,
	limit: number = RECORD_EMBEDDING_BACKFILL_LIMIT,
	targets?: ReadonlyMap<string, ReadonlyArray<string>>
) {
	const summary: Array<{
		readonly collection: string;
		readonly selected: number;
		readonly embedded: number;
		readonly failed: number;
		readonly issues?: ReadonlyArray<string>;
	}> = [];
	for (const collection of ports.collections) {
		const declared = collection.embedding;
		if (declared === undefined) continue;
		const targetIds = targets?.get(collection.name);
		if (targets !== undefined && (targetIds === undefined || targetIds.length === 0)) continue;
		const fields = declared.fields.filter((name) => collection.fields[name] !== undefined);
		if (fields.length === 0) continue;
		const table = quoteIdentifier(collection.name);
		const selected = yield* ports.database.execute(
			EffectId.make(`${effectId}:select:${collection.name}`),
			{
				_tag: 'Query',
				// repository-health:allow SQL1 -- identifiers come from the compiled workspace definition.
				sql: `select "id", "updated_at", ${quoteIdentifier(RECORD_EMBEDDING_COLUMN)}, ${quoteIdentifier(RECORD_EMBEDDING_FINGERPRINT_COLUMN)}, ${fields.map(quoteIdentifier).join(', ')} from ${table} where (${quoteIdentifier(RECORD_EMBEDDING_COLUMN)} is null or ${quoteIdentifier(EMBEDDED_AT_COLUMN)} is null or ${quoteIdentifier(EMBEDDED_AT_COLUMN)} < "updated_at")${targetIds === undefined ? '' : ' and "id" = any($2::uuid[])'} order by "id" limit $1`,
				parameters: targetIds === undefined ? [limit] : [limit, targetIds]
			}
		);
		const offsets = Array.from(
			{ length: Math.ceil(selected.rows.length / RECORD_EMBEDDING_BATCH_ROWS) },
			(_, index) => index * RECORD_EMBEDDING_BATCH_ROWS
		);
		const embeddedByBatch = yield* Effect.forEach(
			offsets,
			(offset) =>
				Effect.gen(function* () {
					const batchId = EffectId.make(`${effectId}:${collection.name}:${offset}`);
					const batch = selected.rows.slice(offset, offset + RECORD_EMBEDDING_BATCH_ROWS);
					const prepared: Array<{
						readonly id: unknown;
						readonly updatedAt: unknown;
						readonly fingerprint: string;
						readonly input: Schema.Json;
					}> = [];
					const unchanged: Array<
						Record<'id' | 'updated_at', unknown> & { readonly fingerprint: string }
					> = [];
					let invalid = 0;
					for (const row of batch) {
						const record = row as Readonly<Record<string, unknown>>;
						const parts = yield* recordEmbeddingParts(ports, collection, record);
						if (parts.length === 0) {
							invalid += 1;
							continue;
						}
						const source = Object.fromEntries(fields.map((field) => [field, record[field]]));
						const fingerprint = `sha256:${sha256Text(JSON.stringify(source))}`;
						if (
							record[RECORD_EMBEDDING_FINGERPRINT_COLUMN] === fingerprint &&
							record[RECORD_EMBEDDING_COLUMN] != null
						) {
							unchanged.push({
								id: record['id'],
								updated_at: record['updated_at'],
								fingerprint
							});
							continue;
						}
						prepared.push({
							id: record['id'],
							updatedAt: record['updated_at'],
							fingerprint,
							input: { content: parts }
						});
					}
					if (unchanged.length > 0)
						yield* ports.database.execute(EffectId.make(`${batchId}:touch`), {
							_tag: 'Query',
							sql: `update ${table} as target set ${quoteIdentifier(EMBEDDED_AT_COLUMN)} = clock_timestamp() from jsonb_to_recordset($1::jsonb) as source(id uuid, updated_at timestamptz, fingerprint text) where target."id" = source.id and target."updated_at" is not distinct from source.updated_at and target.${quoteIdentifier(RECORD_EMBEDDING_FINGERPRINT_COLUMN)} = source.fingerprint`,
							parameters: [JSON.stringify(unchanged) as Schema.Json]
						});
					if (prepared.length === 0) return { embedded: 0, failed: invalid };
					const attempted = yield* ports.ai
						.execute(EffectId.make(`${batchId}:embedding`), {
							_tag: 'Embed',
							model: declared.model ?? 'default',
							inputs: prepared.map(({ input }) => input),
							...(declared.dimensions === undefined ? {} : { dimensions: declared.dimensions })
						})
						.pipe(
							Effect.match({
								onFailure: (failure) => ({
									ok: false as const,
									detail: `${failure.code}: ${failure.message}`
								}),
								onSuccess: (response) => ({ ok: true as const, response })
							})
						);
					if (!attempted.ok)
						return { embedded: 0, failed: invalid + prepared.length, issue: attempted.detail };
					const vectors = Array.isArray(attempted.response.output)
						? (attempted.response.output as ReadonlyArray<ReadonlyArray<number>>)
						: [];
					const writable = prepared.flatMap(({ id, updatedAt, fingerprint }, position) => {
						const embedding = vectors[position];
						return embedding === undefined || embedding.length === 0
							? []
							: [{ id, updated_at: updatedAt, fingerprint, embedding }];
					});
					if (writable.length > 0)
						yield* ports.database.execute(EffectId.make(`${batchId}:write`), {
							_tag: 'Query',
							// repository-health:allow SQL1 -- one bound json document; the table name is compiled.
							sql: `update ${table} as target set ${quoteIdentifier(RECORD_EMBEDDING_COLUMN)} = (source.embedding)::text::vector, ${quoteIdentifier(RECORD_EMBEDDING_FINGERPRINT_COLUMN)} = source.fingerprint, ${quoteIdentifier(EMBEDDED_AT_COLUMN)} = clock_timestamp() from jsonb_to_recordset($1::jsonb) as source(id uuid, updated_at timestamptz, fingerprint text, embedding jsonb) where target."id" = source.id and target."updated_at" is not distinct from source.updated_at`,
							parameters: [JSON.stringify(writable) as Schema.Json]
						});
					const failed = invalid + prepared.length - writable.length;
					return {
						embedded: writable.length,
						failed,
						...(failed === 0 ? {} : { issue: `${failed} record(s) returned no usable vector` })
					};
				}),
			{ concurrency: RECORD_EMBEDDING_BATCH_CONCURRENCY }
		);
		const embedded = embeddedByBatch.reduce((total, batch) => total + batch.embedded, 0);
		const failed = embeddedByBatch.reduce((total, batch) => total + batch.failed, 0);
		const issues = [
			...new Set(
				embeddedByBatch.flatMap((batch) => (batch.issue === undefined ? [] : [batch.issue]))
			)
		];
		summary.push({
			collection: collection.name,
			selected: selected.rows.length,
			embedded,
			failed,
			...(issues.length === 0 ? {} : { issues })
		});
	}
	return summary;
});
