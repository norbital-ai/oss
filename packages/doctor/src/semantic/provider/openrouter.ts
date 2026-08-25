/**
 * The OpenRouter embeddings adapter — the one place that knows this provider's wire format.
 *
 * Everything above the provider layer speaks `Embedder`; everything below translates. The
 * translation here encodes three decisions. First, Qwen's asymmetric retrieval recipe: indexed
 * documents go up verbatim while queries carry an instruction prefix, so both sides of every
 * cosine are computed in the space the model was trained for — and because the prefix changes
 * the vector space, it is hashed into the embedder id, which is what makes a stale index refuse
 * to mix with fresh vectors instead of silently scoring nonsense.
 *
 * Second, retry policy lives in the adapter, not the caller: 429 and 529 plus transport errors
 * back off on fixed delays, because every caller inventing its own backoff is how a rate limit
 * becomes an outage. Counters count *attempts*, not successes — a bill includes the requests the
 * provider refused.
 *
 * Third, `fetchImpl` and `delay` are injectable so the tests run against a local stub with zero
 * network and zero wall-clock sleeping; determinism in tests is worth the two optional fields.
 */
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Embedder, EmbedKind } from '../embedder.js';

/**
 * The query-side instruction. Part of the public surface only so the id's derivation is
 * inspectable; changing this string must change embedder ids and therefore invalidate indexes,
 * which the hash below arranges automatically.
 */
export const QUERY_INSTRUCTION =
	'Instruct: Retrieve TypeScript source files whose responsibility is semantically similar to the query.\nQuery: ';

/** Inputs per HTTP request. Provider limits exist; batching fewer-than-max wastes latency. */
const BATCH_SIZE = 32;

/** Fixed backoff schedule between attempts. */
const RETRY_DELAYS: ReadonlyArray<number> = [250, 1000, 2000, 4000];

/** Total attempts per batch, initial call included. */
const MAX_ATTEMPTS = 4;

const DEFAULT_MODEL = 'qwen/qwen3-embedding-8b';
const DEFAULT_DIMENSIONS = 4096;
const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1';

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 529]);

/** Cumulative spend counters an indexing run reports upward. */
type UsageSnapshot = Readonly<{
	readonly apiRequests: number;
	readonly promptTokens: number | undefined;
	readonly costUsd: number | undefined;
}>;

/** Cumulative spend counters an indexing run reports upward. */
type EmbedderUsage = Readonly<{
	readonly apiRequests: number;
	readonly promptTokens: number | undefined;
	readonly costUsd: number | undefined;
}>;

/** An `Embedder` that additionally reports what its calls spent, as paid APIs owe their callers. */
export type UsageReportingEmbedder = Embedder &
	Readonly<{ usage(): EmbedderUsage }>;

type OpenRouterOptions = Readonly<{
	readonly apiKey: string;
	readonly model?: string | undefined;
	readonly dimensions?: number | undefined;
	readonly endpoint?: string | undefined;
	readonly fetchImpl?: typeof fetch | undefined;
	readonly delay?: ((ms: number) => Promise<void>) | undefined;
}>;

type EmbeddingResponse = Readonly<{
	data?: unknown;
	usage?: unknown;
}>;

const failure = (status: number | 'network', detail: string): Error =>
	new Error(
		`norbital-doctor: openrouter embeddings failed (${status}): ${detail.slice(0, 200)}`
	);

/**
 * Build the OpenRouter-backed embedder. The returned object satisfies plain `Embedder`; callers
 * that care about spend narrow to `UsageReportingEmbedder` (or duck-type `usage`).
 */
export function createOpenRouterEmbedder(options: OpenRouterOptions): Embedder {
	const apiKey = options.apiKey;
	const model = options.model ?? DEFAULT_MODEL;
	const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
	const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
	const doFetch = options.fetchImpl ?? fetch.bind(globalThis);
	const wait =
		options.delay ??
		// `timers/promises` timeout is cancellable on abort and carries no leaked handle, so a
		// discarded timer is not a thing this code can create.
		((ms: number): Promise<void> => sleep(ms));
	// The instruction participates in the id through a short digest: stable across runs, but
	// guaranteed to change — and thereby invalidate stored vectors — if the wording ever does.
	const instructionTag = createHash('sha256').update(QUERY_INSTRUCTION).digest('hex').slice(0, 8);

	const usage: { apiRequests: number; promptTokens: number | undefined; costUsd: number | undefined } =
		{ apiRequests: 0, promptTokens: undefined, costUsd: undefined };

	const request = async (batch: ReadonlyArray<string>): Promise<Array<Float32Array>> => {
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			// repository-health:allow A6 -- embedding is a rate-limited pay-per-request
			// endpoint; sequencing is the retry policy, not an accident of the loop.
			// repository-health:allow A6 -- embedding requests are metered and rate-limited;
			// sequencing batches is the retry policy rather than a lost batching opportunity.
			usage.apiRequests += 1;
			// repository-health:allow A6 -- the run-loop await is the sequencing: one batch, its
			// retries, then the next batch.
			const outcome = await Effect.runPromise(
				Effect.result(
					Effect.tryPromise(async () => {
						const response = await doFetch(`${endpoint}/embeddings`, {
							method: 'POST',
							headers: {
								authorization: `Bearer ${apiKey}`,
								'content-type': 'application/json'
							},
							body: JSON.stringify({
								model,
								input: [...batch],
								encoding_format: 'float',
								...(dimensions === undefined ? {} : { dimensions })
							})
						});
						return { response, body: await response.text() };
					})
				)
			);
			if (Result.isFailure(outcome)) {
				if (attempt < MAX_ATTEMPTS - 1) {
					// repository-health:allow A6 -- the sequencing IS the backoff policy.
					await wait(RETRY_DELAYS[attempt] ?? 0);
					continue;
				}
				throw failure('network', Result.match(outcome, {
					onFailure: (e) => {
						const cause = (e as { cause?: unknown })?.cause;
						return cause instanceof Error ? cause.message : String(cause ?? e);
					},
					onSuccess: () => ''
				}));
			}
			const { response, body } = Result.match(outcome, { onFailure: () => ({ response: null as never, body: '' }), onSuccess: (v) => v });

			if (!response.ok) {
				if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
					// repository-health:allow A6 -- the sequencing IS the backoff policy.
					await wait(RETRY_DELAYS[attempt] ?? 0);
					continue;
				}
				throw failure(response.status, body);
			}

			/*
			 * Decode defensively rather than trusting a provider's contract: the shape is checked
			 * field by field, and a check that existed only as a cast would be evidence-shaped
			 * rather than evidence. The same disassembly the scanner uses on receipts.
			 */
			// The provider response is a received shape and is decoded at the boundary: the wire
			// value becomes a typed envelope, and every read below is a read of what was parsed.
			const decoded = Effect.runSync(Effect.result(
			// repository-health:allow R6b -- the parse becomes a schema decode on the next step.
			Effect.try(() => JSON.parse(body))
		));
			if (Result.isFailure(decoded))
				throw failure(response.status, `malformed JSON: ${body}`);
			const envelope = decodeEnvelope(Result.match(decoded, { onSuccess: (v) => v, onFailure: () => undefined }));
			if (envelope === undefined)
				throw failure(response.status, 'response is not a record with a data array');
			if (envelope.data.length !== batch.length)
				throw failure(
					response.status,
					`expected ${batch.length} embeddings, received ${envelope.data.length}`
				);

			const vectors = decodeRows(envelope.data, response.status, failure);

			const reported = envelope.usage;
			if (reported !== undefined) {
				if (reported.prompt_tokens !== undefined)
					usage.promptTokens = (usage.promptTokens ?? 0) + reported.prompt_tokens;
				if (reported.cost !== undefined) usage.costUsd = (usage.costUsd ?? 0) + reported.cost;
			}
			return vectors;
		}
		throw new Error('norbital-doctor: openrouter embeddings exhausted retries without failing');
	};

	function decodeRows(
	rows: ReadonlyArray<EmbeddingRow>,
	status: number,
	failure: (status: number, message: string) => Error
): Array<Float32Array> {
	const vectors: Array<Float32Array> = [];
	for (const [index, entry] of rows.entries()) {
		const embedding = entry.embedding;
		if (embedding.length !== dimensions)
			throw failure(status, `embedding ${index} has ${embedding.length} dimensions, expected ${dimensions}`);
		const vector = new Float32Array(dimensions);
		for (const [dimension, value] of embedding.entries()) {
			if (typeof value !== 'number' || !Number.isFinite(value))
				throw failure(status, `embedding ${index} contains a non-finite value at dimension ${dimension}`);
			vector[dimension] = value;
		}
		vectors.push(vector);
	}
	return vectors;
}

interface EmbeddingRow {
	readonly embedding: ReadonlyArray<number>;
}

const EnvelopeSchema = Schema.Struct({
	data: Schema.Array(Schema.Struct({ embedding: Schema.Array(Schema.Number) })),
	usage: Schema.optional(
		Schema.Struct({
			prompt_tokens: Schema.optional(Schema.Number),
			cost: Schema.optional(Schema.Number)
		})
	)
});

type Envelope = {
	readonly data: ReadonlyArray<EmbeddingRow>;
	readonly usage?: { readonly prompt_tokens?: number; readonly cost?: number } | undefined;
};

/** Decode a provider envelope; `undefined` means the shape was not a record with data. */
function decodeEnvelope(value: unknown): Envelope | undefined {
	const decoded = Schema.decodeUnknownResult(EnvelopeSchema)(value);
	return Result.match(decoded, {
		onFailure: () => undefined,
		onSuccess: (envelope) => envelope as Envelope
	});
}

const embed = async (
		texts: ReadonlyArray<string>,
		kind: EmbedKind
	): Promise<Array<Float32Array>> => {
		if (texts.length === 0) return [];
		const inputs =
			kind === 'query'
				? texts.map((text) => `${QUERY_INSTRUCTION}${text}`)
				: [...texts];
		const output: Array<Float32Array> = [];
		for (let start = 0; start < inputs.length; start += BATCH_SIZE)
			// repository-health:allow A6 -- one batch at a time keeps the bill legible in the
			// receipt and the retry budget deterministic.
			output.push(...(await request(inputs.slice(start, start + BATCH_SIZE))));
		return output;
	};

	const embedder: UsageReportingEmbedder = {
		id: `openrouter:${model}:${dimensions}:q${instructionTag}`,
		dimensions,
		embed,
		usage: (): EmbedderUsage => ({ ...usage })
	};
	return Object.freeze(embedder);
}
