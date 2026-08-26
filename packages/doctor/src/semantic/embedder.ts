// repository-health:allow SEM_PARALLEL -- SPI <-> adapter: openrouter implements the embedder contract.
/**
 * The embedder contract every semantic provider satisfies, and the accounting every
 * indexing run reports.
 *
 * One signature on purpose. Providers differ in endpoint shape, auth and in how they
 * distinguish an indexed document from a search query — Qwen takes an instruction
 * prefix, Cohere an `input_type`, Gemini a `taskType` — so the contract carries `kind`
 * and lets each adapter translate. Nothing above this file knows any provider's wire
 * format, which is what makes adding one a fifty-line module instead of a redesign.
 *
 * Vectors come back as `Float32Array` because they are written to `vectors.bin`
 * verbatim; converting through plain arrays would allocate every embedding twice.
 */

/** Whether a text is being indexed (a document) or matched against the index (a query). */
export type EmbedKind = 'document' | 'query';

/** A resolved embedding provider. Built by the provider registry from config + env. */
export type Embedder = Readonly<{
	/**
	 * Fingerprint component naming exactly what produced these vectors, e.g.
	 * `openrouter:qwen/qwen3-embedding-8b:4096:v1`. Two indexes whose ids differ are two
	 * vector spaces; the Merkle store refuses to mix them instead of silently comparing
	 * numbers that mean different things.
	 */
	readonly id: string;
	readonly dimensions: number;
	/** Embed texts in input order; one returned vector per input text. */
	embed(texts: ReadonlyArray<string>, kind: EmbedKind): Promise<Array<Float32Array>>;
}>;

/**
 * What an index refresh cost. Surfaced verbatim in the receipt, the CLI summary and the
 * consolidated report: an analysis tier that calls a paid API owes its reader the bill.
 *
 * Token counts come from the provider's own usage report when it gives one; a missing
 * count is recorded as `undefined` rather than estimated, because a guess presented as a
 * measurement is worse than an honest hole.
 */
export type IndexRunStats = Readonly<{
	/** Files in scope when the run finished. */
	readonly filesTotal: number;
	/** Files embedded this run — new or changed since the last index. */
	readonly filesEmbedded: number;
	/** Files whose Merkle leaf was unchanged and whose stored vector was reused. */
	readonly filesUnchanged: number;
	/** Files dropped from the index because their source disappeared. */
	readonly filesDeleted: number;
	/** HTTP requests issued to the provider, including retries. */
	readonly apiRequests: number;
	/** Prompt tokens reported by the provider across all requests, if it reports usage. */
	readonly promptTokens: number | undefined;
	/** Cost reported by the provider, if it reports one. Never computed locally. */
	readonly costUsd: number | undefined;
	/** Wall-clock milliseconds for the whole refresh, network included. */
	readonly durationMs: number;
}>;

const emptyIndexRunStats: IndexRunStats = {
	filesTotal: 0,
	filesEmbedded: 0,
	filesUnchanged: 0,
	filesDeleted: 0,
	apiRequests: 0,
	promptTokens: undefined,
	costUsd: undefined,
	durationMs: 0
};
