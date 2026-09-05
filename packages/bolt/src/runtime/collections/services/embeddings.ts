import { Effect, Option, Schema } from 'effect';
import {
	AIRequest,
	EffectId,
	ImageAsset,
	ModelId,
	ProviderCallId
} from '@norbital-ai/bolt-protocol';
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

type RecordEmbeddingInput =
	| Readonly<{
			_tag: 'Ready';
			input: Schema.Json;
			imageAssets: ReadonlyArray<ImageAsset>;
	  }>
	| Readonly<{ _tag: 'Invalid'; issue: string }>;

type EmbeddingAttempt =
	| Readonly<{ ok: true; embedding: ReadonlyArray<number> }>
	| Readonly<{ ok: false; issue: string }>;

export const RECORD_EMBEDDING_BACKFILL_LIMIT = 512;
const RECORD_EMBEDDING_BATCH_ROWS = 100;
const RECORD_EMBEDDING_REQUEST_CONCURRENCY = 4;

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const jsonRecord = Schema.is(JsonObject);
const isString = Schema.is(Schema.String);
const encodeJsonText = (value: unknown): string => {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new TypeError('Embedding state is not JSON encodable');
	return encoded;
};

type EmbeddingPorts = Readonly<{
	readonly database: Pick<Database.Interface, 'execute'>;
	readonly ai: Pick<AIInterface, 'embed'>;
	readonly collections: ReadonlyArray<EmbeddingCollection>;
}>;

/** Builds one provider-neutral input plus host-resolved image descriptors for one record. */
export const recordEmbeddingInput = Effect.fn('Collections.recordEmbeddingInput')(function* (
	collection: EmbeddingCollection,
	row: Readonly<Record<string, unknown>>
) {
	const text: Array<string> = [];
	const imageAssets: Array<ImageAsset> = [];
	for (const name of collection.embedding?.fields ?? []) {
		const value = row[name];
		if (value == null) continue;
		if (
			collection.fields[name]?.type === 'json' &&
			jsonRecord(value) &&
			'storage_key' in value
		) {
			const decoded = Schema.decodeUnknownOption(ImageAsset)({
				key: value['storage_key'],
				name: value['file_name'],
				mimeType: value['mime_type'],
				size: value['file_size']
			});
			if (Option.isNone(decoded)) {
				return {
					_tag: 'Invalid',
					issue: `${collection.name}.${name} contains an invalid image descriptor`
				} satisfies RecordEmbeddingInput;
			}
			if (!decoded.value.mimeType.startsWith('image/')) {
				return {
					_tag: 'Invalid',
					issue: `${collection.name}.${name} is not an image`
				} satisfies RecordEmbeddingInput;
			}
			imageAssets.push(decoded.value);
			continue;
		}
		const encoded = isString(value) ? value : encodeJsonText(value);
		if (encoded.trim() === '') continue;
		text.push(encoded);
	}
	if (text.length === 0 && imageAssets.length === 0) {
		return {
			_tag: 'Invalid',
			issue: `${collection.name} contains no embeddable source value`
		} satisfies RecordEmbeddingInput;
	}
	return {
		_tag: 'Ready',
		input: text.join('\n'),
		imageAssets
	} satisfies RecordEmbeddingInput;
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
		if (declared.model === undefined || declared.model.trim() === '') {
			summary.push({
				collection: collection.name,
				selected: 0,
				embedded: 0,
				failed: 0,
				issues: ['A collection embedding declaration requires an explicit model id']
			});
			continue;
		}
		const modelId = ModelId.make(declared.model);
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
						readonly imageAssets: ReadonlyArray<ImageAsset>;
					}> = [];
					const unchanged: Array<
						Record<'id' | 'updated_at', unknown> & { readonly fingerprint: string }
					> = [];
					const inputIssues: Array<string> = [];
					let invalid = 0;
					for (const row of batch) {
						if (!jsonRecord(row)) {
							invalid += 1;
							inputIssues.push('The embedding query returned a non-record row');
							continue;
						}
						const sourceInput = yield* recordEmbeddingInput(collection, row);
						if (sourceInput._tag === 'Invalid') {
							invalid += 1;
							inputIssues.push(sourceInput.issue);
							continue;
						}
						const source = Object.fromEntries(fields.map((field) => [field, row[field]]));
						const fingerprint = `sha256:${sha256Text(encodeJsonText(source))}`;
						if (
							row[RECORD_EMBEDDING_FINGERPRINT_COLUMN] === fingerprint &&
							row[RECORD_EMBEDDING_COLUMN] != null
						) {
							unchanged.push({
								id: row['id'],
								updated_at: row['updated_at'],
								fingerprint
							});
							continue;
						}
						prepared.push({
							id: row['id'],
							updatedAt: row['updated_at'],
							fingerprint,
							input: sourceInput.input,
							imageAssets: sourceInput.imageAssets
						});
					}
					if (unchanged.length > 0) {
						yield* ports.database.execute(EffectId.make(`${batchId}:touch`), {
							_tag: 'Query',
							sql: `update ${table} as target set ${quoteIdentifier(EMBEDDED_AT_COLUMN)} = clock_timestamp() from jsonb_to_recordset($1::jsonb) as source(id uuid, updated_at timestamptz, fingerprint text) where target."id" = source.id and target."updated_at" is not distinct from source.updated_at and target.${quoteIdentifier(RECORD_EMBEDDING_FINGERPRINT_COLUMN)} = source.fingerprint`,
							parameters: [encodeJsonText(unchanged)]
						});
					}
					if (prepared.length === 0) {
						return {
							embedded: 0,
							failed: invalid,
							issues: inputIssues
						};
					}
					const attempts = yield* Effect.forEach(
						prepared,
						(item, position) =>
							ports.ai
								.embed(
									EffectId.make(`${batchId}:embedding:${position}`),
									AIRequest.cases.Embed.make({
										callId: ProviderCallId.make(`${batchId}:embedding:${position}`),
										modelId,
										inputs: [item.input],
										...(declared.dimensions === undefined
											? {}
											: { dimensions: declared.dimensions }),
										...(item.imageAssets.length === 0
											? {}
											: { imageAssets: item.imageAssets })
									})
								)
								.pipe(
									Effect.match({
										onFailure: (failure): EmbeddingAttempt => ({
											ok: false,
											issue: `${failure.code}: ${failure.message}`
										}),
										onSuccess: (response): EmbeddingAttempt => {
											const embedding = response.embeddings[0];
											return embedding === undefined || embedding.length === 0
												? { ok: false, issue: 'AI provider returned no usable vector' }
												: { ok: true, embedding };
										}
									})
								),
						{ concurrency: RECORD_EMBEDDING_REQUEST_CONCURRENCY }
					);
					const writable: Array<{
						readonly id: unknown;
						readonly updated_at: unknown;
						readonly fingerprint: string;
						readonly embedding: ReadonlyArray<number>;
					}> = [];
					const providerIssues: Array<string> = [];
					for (let position = 0; position < attempts.length; position += 1) {
						const attempt = attempts[position];
						const item = prepared[position];
						if (attempt === undefined || item === undefined) continue;
						if (!attempt.ok) {
							providerIssues.push(attempt.issue);
							continue;
						}
						writable.push({
							id: item.id,
							updated_at: item.updatedAt,
							fingerprint: item.fingerprint,
							embedding: attempt.embedding
						});
					}
					if (writable.length > 0) {
						yield* ports.database.execute(EffectId.make(`${batchId}:write`), {
							_tag: 'Query',
							// repository-health:allow SQL1 -- one bound json document; the table name is compiled.
							sql: `update ${table} as target set ${quoteIdentifier(RECORD_EMBEDDING_COLUMN)} = (source.embedding)::text::vector, ${quoteIdentifier(RECORD_EMBEDDING_FINGERPRINT_COLUMN)} = source.fingerprint, ${quoteIdentifier(EMBEDDED_AT_COLUMN)} = clock_timestamp() from jsonb_to_recordset($1::jsonb) as source(id uuid, updated_at timestamptz, fingerprint text, embedding jsonb) where target."id" = source.id and target."updated_at" is not distinct from source.updated_at`,
							parameters: [encodeJsonText(writable)]
						});
					}
					return {
						embedded: writable.length,
						failed: invalid + prepared.length - writable.length,
						issues: [...inputIssues, ...providerIssues]
					};
			})
		);
		const embedded = embeddedByBatch.reduce((total, batch) => total + batch.embedded, 0);
		const failed = embeddedByBatch.reduce((total, batch) => total + batch.failed, 0);
		const issues = [
			...new Set(embeddedByBatch.flatMap((batch) => batch.issues))
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
