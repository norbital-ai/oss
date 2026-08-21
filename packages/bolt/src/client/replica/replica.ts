import type { Schema } from 'effect';

export type LocalSql = Readonly<{
	readonly query: (
		sql: string,
		parameters: ReadonlyArray<Schema.Json>
	) => Promise<ReadonlyArray<Schema.Json>>;
	readonly applyChange: (change: Schema.Json) => Promise<void>;
	readonly reset: () => Promise<void>;
}>;
