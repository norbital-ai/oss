import { Effect, Option, Schema } from 'effect';
import {
	AIRequest,
	EffectId,
	EmbeddingInput,
	ImageAsset,
	ModelId,
	ProviderCallId
} from '@norbital-ai/bolt-protocol';
import { sha256Text } from '@norbital-ai/std/reckon/hash';
import {
	DEFAULT_RECORD_EMBEDDING_DIMENSIONS,
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
	Readonly<{ _tag: 'Ready'; input: EmbeddingInput }> | Readonly<{ _tag: 'Invalid'; issue: string }>;

type EmbeddingAttempt =
	Readonly<{ ok: true; embedding: ReadonlyArray<number> }> | Readonly<{ ok: false; issue: string }>;

export const RECORD_EMBEDDING_BACKFILL_LIMIT = 512;

/** One collection's outcome from a backfill pass, as the caller and its audit read it. */
export type EmbeddingPassSummary = Readonly<{
	readonly collection: string;
	readonly selected: number;
	readonly embedded: number;
	readonly failed: number;
	readonly issues?: ReadonlyArray<string>;
}>;

export type EmbedRecordsOptions = Readonly<{
	readonly limit?: number;
	/** Narrow the pass to these collection names; absent means every declared embedding. */
	readonly only?: ReadonlySet<string>;
	/** Narrow the pass to named rows per collection; absent means every row without one. */
	readonly targets?: ReadonlyMap<string, ReadonlyArray<string>>;
}>;

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const jsonRecord = Schema.is(JsonObject);
const encodeJsonText = (value: unknown): string => {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new TypeError('Embedding state is not JSON encodable');
	return encoded;
};

type EmbeddingPorts = Readonly<{
	readonly database: Pick<Database.Interface, 'execute'>;
	readonly ai: Pick<AIInterface, 'catalog' | 'embed'>;
	readonly collections: ReadonlyArray<EmbeddingCollection>;
}>;

/**
 * The model and width a collection embeds with — its declared knob, else the host's default model —
 * shared by the record pass and the query probe so the two vectors are always comparable. The width
 * is always sent: the column was created with it.
 */
export const embeddingModel = Effect.fn('Collections.embeddingModel')(function* (
	ai: Pick<AIInterface, 'catalog'>,
	effectId: EffectId,
	declared: Readonly<{ readonly model?: string; readonly dimensions?: number }>
) {
	const modelId =
		declared.model === undefined
			? (yield* ai.catalog(effectId, { _tag: 'Catalog' })).defaultEmbeddingModelId
			: ModelId.make(declared.model);
	return { modelId, dimensions: declared.dimensions ?? DEFAULT_RECORD_EMBEDDING_DIMENSIONS };
});

/** Builds one provider-neutral embedding input plus host-resolved image descriptors per record. */
export const recordEmbeddingInput = Effect.fn('Collections.recordEmbeddingInput')(function* (
	collection: EmbeddingCollection,
	row: Readonly<Record<string, unknown>>
) {
	const text: Array<string> = [];
	const imageAssets: Array<ImageAsset> = [];
	for (const name of collection.embedding?.fields ?? []) {
		const value = row[name];
		if (value == null) continue;
		if (collection.fields[name]?.type === 'json' && jsonRecord(value) && 'storage_key' in value) {
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
		const encoded = typeof value === 'string' ? value : encodeJsonText(value);
		if (encoded.trim() === '') continue;
		text.push(encoded);
	}
	if (text.length === 0 && imageAssets.length === 0) {
		return {
			_tag: 'Invalid',
			issue: `${collection.name} contains no embeddable source value`
		} satisfies RecordEmbeddingInput;
	}
	const joined = text.join('\n');
	return {
		_tag: 'Ready',
		input: {
			...(joined === '' ? {} : { text: joined }),
			...(imageAssets.length === 0 ? {} : { imageAssets })
		}
	} satisfies RecordEmbeddingInput;
});

/** One bounded backfill pass; derived embedding settlement never wakes live queries. */
export const embedRecords = Effect.fn('Collections.embedRecords')(function* (
	ports: EmbeddingPorts,
	effectId: EffectId,
	options: EmbedRecordsOptions = {}
) {
	const { limit = RECORD_EMBEDDING_BACKFILL_LIMIT, only, targets } = options;
	const summary: Array<EmbeddingPassSummary> = [];
	for (const collection of ports.collections) {
		if (only !== undefined && !only.has(collection.name)) continue;
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
				sql: `select "id", "updated_at"::text as "updated_at", ${quoteIdentifier(RECORD_EMBEDDING_COLUMN)}, ${quoteIdentifier(RECORD_EMBEDDING_FINGERPRINT_COLUMN)}, ${fields.map(quoteIdentifier).join(', ')} from ${table} where (${quoteIdentifier(RECORD_EMBEDDING_COLUMN)} is null or ${quoteIdentifier(EMBEDDED_AT_COLUMN)} is null or ${quoteIdentifier(EMBEDDED_AT_COLUMN)} < "updated_at")${targetIds === undefined ? '' : ' and "id" = any($2::uuid[])'} order by "id" limit $1`,
				parameters: targetIds === undefined ? [limit] : [limit, targetIds]
			}
		);
		const pass = yield* Effect.gen(function* () {
			const batchId = EffectId.make(`${effectId}:${collection.name}:0`);
			const batch = selected.rows;
			const prepared: Array<{
				readonly id: unknown;
				readonly updatedAt: unknown;
				readonly fingerprint: string;
				readonly input: EmbeddingInput;
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
					input: sourceInput.input
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
			/**
			 * The whole pass is one embedding request: a record is one input in it, never a call of
			 * its own. How many inputs one provider call may carry is the provider's limit, so the
			 * host facility splits the request to fit it; Bolt names no batch size.
			 */
			const requestId = `${batchId}:embedding:0`;
			const flattened = yield* embeddingModel(ports.ai, EffectId.make(`${batchId}:model`), declared)
				.pipe(
					Effect.flatMap(({ modelId, dimensions }) =>
						ports.ai.embed(
							EffectId.make(requestId),
							AIRequest.cases.Embed.make({
								callId: ProviderCallId.make(requestId),
								modelId,
								inputs: prepared.map((item) => item.input),
								dimensions
							})
						)
					)
				)
				.pipe(
					Effect.match({
						onFailure: (failure): ReadonlyArray<EmbeddingAttempt> =>
							prepared.map(() => ({
								ok: false as const,
								issue: `${failure.code}: ${failure.message}`
							})),
						onSuccess: (embedded): ReadonlyArray<EmbeddingAttempt> =>
							prepared.map((_, position) => {
								const embedding = embedded.embeddings[position];
								return embedding === undefined || embedding.length === 0
									? { ok: false as const, issue: 'AI provider returned no usable vector' }
									: { ok: true as const, embedding };
							})
					})
				);
			const writable: Array<{
				readonly id: unknown;
				readonly updated_at: unknown;
				readonly fingerprint: string;
				readonly embedding: ReadonlyArray<number>;
			}> = [];
			const providerIssues: Array<string> = [];
			for (let position = 0; position < flattened.length; position += 1) {
				const attempt = flattened[position];
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
		});
		const { embedded, failed } = pass;
		const issues = [...new Set(pass.issues)];
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
