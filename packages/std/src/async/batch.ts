async function runPool<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	if (concurrency < 1) {
		throw new Error('concurrency must be at least 1');
	}
	const out: R[] = [];
	// stupidity:allow A6 -- each awaited chunk enforces the requested concurrency ceiling
	for (let i = 0; i < items.length; i += concurrency) {
		const batch = items.slice(i, i + concurrency);
		const batchResults = await Promise.all(batch.map((item, j) => fn(item, i + j)));
		out.push(...batchResults);
	}
	return out;
}

export type BatchContext = {
	readonly batchIndex: number;
	readonly offset: number;
	readonly batchSize: number;
};

export type PaginatedBatchSource<TItem> = {
	readonly mode: 'paginated';
	readonly fetch: (offset: number, limit: number) => Promise<readonly TItem[]>;
	readonly maxOffset?: number;
};

export type ItemsBatchSource<TItem> = {
	readonly mode: 'items';
	readonly items: readonly TItem[];
};

export type BatchSource<TItem> = PaginatedBatchSource<TItem> | ItemsBatchSource<TItem>;

/** Item type carried by a {@link BatchSource}. */
export type BatchSourceItem<TSource extends BatchSource<unknown>> =
	TSource extends BatchSource<infer TItem> ? TItem : never;

export type BatchRunFn<TItem, TBatchOutput> = (
	batch: readonly TItem[],
	ctx: BatchContext
) => Promise<TBatchOutput> | TBatchOutput;

export type BatchCollectFn<TBatchOutput, TFinal> = (results: readonly TBatchOutput[]) => TFinal;

/** Inferred final result of a {@link batchOperation} call from its options object. */
export type BatchOperationResult<TOptions extends { readonly source: BatchSource<unknown> }> =
	TOptions extends BatchOperationReduceOptions<
		BatchSourceItem<TOptions['source']>,
		infer TBatchOutput,
		infer TFinal
	>
		? TFinal
		: TOptions extends BatchOperationMapOptions<
					BatchSourceItem<TOptions['source']>,
					infer TBatchOutput
			  >
			? TBatchOutput[]
			: BatchSourceItem<TOptions['source']>[];

type BatchOperationSharedOptions = {
	readonly batchSize: number;
	readonly parallel?: boolean;
	readonly concurrency?: number;
	readonly signal?: AbortSignal;
};

/** Fetch or chunk items and concatenate batch outputs. */
export type BatchOperationFlatOptions<TItem> = BatchOperationSharedOptions & {
	readonly source: BatchSource<TItem>;
	readonly run?: undefined;
	readonly collect?: undefined;
};

/** Run a per-batch handler; returns one output per batch. */
export type BatchOperationMapOptions<TItem, TBatchOutput> = BatchOperationSharedOptions & {
	readonly source: BatchSource<TItem>;
	readonly run: BatchRunFn<TItem, TBatchOutput>;
	readonly collect?: undefined;
};

/** Run a per-batch handler and reduce batch outputs into a single value. */
export type BatchOperationReduceOptions<TItem, TBatchOutput, TFinal> =
	BatchOperationSharedOptions & {
		readonly source: BatchSource<TItem>;
		readonly run: BatchRunFn<TItem, TBatchOutput>;
		readonly collect: BatchCollectFn<TBatchOutput, TFinal>;
	};

export type BatchOperationOptions<TItem, TBatchOutput = TItem[], TFinal = TBatchOutput[]> =
	| BatchOperationFlatOptions<TItem>
	| BatchOperationMapOptions<TItem, TBatchOutput>
	| BatchOperationReduceOptions<TItem, TBatchOutput, TFinal>;

export function paginatedSource<TItem>(
	fetch: (offset: number, limit: number) => Promise<readonly TItem[]>,
	options?: { readonly maxOffset?: number }
): PaginatedBatchSource<TItem> {
	return {
		mode: 'paginated',
		fetch,
		maxOffset: options?.maxOffset
	};
}

export function itemsSource<const TItem>(items: readonly TItem[]): ItemsBatchSource<TItem> {
	return { mode: 'items', items };
}

function createBatchContext(batchIndex: number, offset: number, batchSize: number): BatchContext {
	return { batchIndex, offset, batchSize };
}

async function runSequentialBatches<TItem, TBatchOutput>(
	batches: readonly (readonly TItem[])[],
	batchSize: number,
	run: BatchRunFn<TItem, TBatchOutput>,
	signal?: AbortSignal
): Promise<TBatchOutput[]> {
	const results: TBatchOutput[] = [];
	// stupidity:allow A6 -- this is the explicit non-parallel execution path
	for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
		signal?.throwIfAborted();
		const batch = batches[batchIndex]!;
		results.push(
			await run(batch, createBatchContext(batchIndex, batchIndex * batchSize, batchSize))
		);
	}
	return results;
}

async function runParallelBatches<TItem, TBatchOutput>(
	batches: readonly (readonly TItem[])[],
	batchSize: number,
	concurrency: number,
	run: BatchRunFn<TItem, TBatchOutput>,
	signal?: AbortSignal
): Promise<TBatchOutput[]> {
	return runPool(batches, concurrency, async (batch, batchIndex) => {
		signal?.throwIfAborted();
		return run(batch, createBatchContext(batchIndex, batchIndex * batchSize, batchSize));
	});
}

function chunkItems<TItem>(
	items: readonly TItem[],
	batchSize: number
): readonly (readonly TItem[])[] {
	const batches: TItem[][] = [];
	for (let offset = 0; offset < items.length; offset += batchSize) {
		batches.push(items.slice(offset, offset + batchSize));
	}
	return batches;
}

async function loadPaginatedBatches<TItem>(
	source: PaginatedBatchSource<TItem>,
	batchSize: number,
	signal?: AbortSignal
): Promise<readonly (readonly TItem[])[]> {
	const batches: TItem[][] = [];

	// stupidity:allow A6 -- offset pagination must observe each page before requesting the next
	for (let offset = 0; ; offset += batchSize) {
		signal?.throwIfAborted();
		if (source.maxOffset !== undefined && offset >= source.maxOffset) break;

		const limit =
			source.maxOffset !== undefined ? Math.min(batchSize, source.maxOffset - offset) : batchSize;
		const page = await source.fetch(offset, limit);
		if (page.length === 0) break;
		batches.push([...page]);
		if (page.length < limit) break;
	}

	return batches;
}

function flattenBatches<TItem>(batches: readonly (readonly TItem[])[]): TItem[] {
	const out: TItem[] = [];
	for (const batch of batches) {
		out.push(...batch);
	}
	return out;
}

export async function batchOperation<TItem>(
	options: BatchOperationFlatOptions<TItem>
): Promise<TItem[]>;
export async function batchOperation<TItem, TBatchOutput>(
	options: BatchOperationMapOptions<TItem, TBatchOutput>
): Promise<TBatchOutput[]>;
export async function batchOperation<TItem, TBatchOutput, TFinal>(
	options: BatchOperationReduceOptions<TItem, TBatchOutput, TFinal>
): Promise<TFinal>;
export async function batchOperation<TItem, TBatchOutput, TFinal>(
	options: BatchOperationOptions<TItem, TBatchOutput, TFinal>
): Promise<TItem[] | TBatchOutput[] | TFinal> {
	const { source, batchSize, run, collect, parallel = false, concurrency = 4, signal } = options;

	if (batchSize < 1) {
		throw new Error('batchSize must be at least 1');
	}
	if (parallel && concurrency < 1) {
		throw new Error('concurrency must be at least 1');
	}
	if (parallel && source.mode === 'paginated') {
		throw new Error('parallel batching requires an items source');
	}

	const batches =
		source.mode === 'paginated'
			? await loadPaginatedBatches(source, batchSize, signal)
			: chunkItems(source.items, batchSize);

	if (!run) {
		return flattenBatches(batches);
	}

	const results = parallel
		? await runParallelBatches(batches, batchSize, concurrency, run, signal)
		: await runSequentialBatches(batches, batchSize, run, signal);

	if (collect) {
		return collect(results);
	}

	return results;
}
