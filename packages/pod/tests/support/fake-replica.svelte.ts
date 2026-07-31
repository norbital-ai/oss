/**
 * A replica seam, not a database.
 *
 * The surfaces under test read the workspace through one narrow contract: `db[collection].findMany`
 * returns a live query with `current`/`loading`, and the sync engine re-fires that query when a diff
 * for the collection lands (`setSyncInvalidator` in runtime/client.ts). Faking Postgres to test a
 * chat panel would test Postgres; faking that contract tests the panel.
 *
 * What the fake must not do is answer synchronously. A query that already holds its rows at mount
 * proves nothing about liveness — every assertion would pass against a component that read once and
 * never listened again. So every emission here is deferred by a turn: the first load, and every
 * write that lands afterwards. A test that sees a row has necessarily seen the component react.
 */

type Row = Record<string, unknown>;

type FindManyInput = {
	readonly where?: Readonly<Record<string, unknown>>;
	readonly orderBy?: Readonly<Record<string, 'asc' | 'desc'>>;
	readonly limit?: number;
};

class FakeLiveQuery {
	current = $state<Row[] | undefined>(undefined);
	loading = $state(true);
	readonly error = undefined;

	constructor(readonly read: () => Row[]) {}

	/** Deliver what the replica holds now, a turn from now. */
	emit(): void {
		setTimeout(() => {
			this.current = this.read();
			this.loading = false;
		}, 0);
	}

	async refresh(): Promise<void> {
		this.emit();
	}
}

function matches(row: Row, where: FindManyInput['where']): boolean {
	if (!where) return true;
	return Object.entries(where).every(([column, value]) => row[column] === value);
}

function compare(left: Row, right: Row, orderBy: FindManyInput['orderBy']): number {
	if (!orderBy) return 0;
	for (const [column, direction] of Object.entries(orderBy)) {
		const a = String(left[column] ?? '');
		const b = String(right[column] ?? '');
		if (a === b) continue;
		return direction === 'desc' ? (a < b ? 1 : -1) : a < b ? -1 : 1;
	}
	return 0;
}

export class FakeReplica {
	readonly #rows = new Map<string, Row[]>();
	readonly #queries = new Map<string, FakeLiveQuery>();
	/** Every write the surface issued, in order, so a test can assert the mutation and not just the paint. */
	readonly writes: { collection: string; id: string; patch: Row }[] = [];

	/** Rows already in the replica before anything mounts — what a device that has synced looks like. */
	seed(collection: string, rows: readonly Row[]): void {
		this.#rows.set(collection, [...(this.#rows.get(collection) ?? []), ...rows]);
	}

	/**
	 * A row arriving from somewhere that is not this surface: the agent loop, a channel, another tab.
	 * Nothing local was clicked; the sync engine simply put it in the replica and re-fired the reads.
	 */
	arrive(collection: string, row: Row): void {
		this.seed(collection, [row]);
		this.#refire(collection);
	}

	readonly db = new Proxy({} as Record<string, unknown>, {
		get: (_target, collection: string) => this.#collection(collection)
	});

	#collection(collection: string): Record<string, unknown> {
		return {
			findMany: (input: FindManyInput = {}) => this.#findMany(collection, input),
			update: async (id: string, patch: Row): Promise<void> => {
				this.writes.push({ collection, id, patch });
				const rows = this.#rows.get(collection) ?? [];
				const target = rows.find((row) => row.norbital_id === id);
				if (target) Object.assign(target, patch);
				this.#refire(collection);
			}
		};
	}

	#findMany(collection: string, input: FindManyInput): FakeLiveQuery {
		// One resource per (collection, query), as the real manager keys them — a component whose
		// `$derived` re-evaluates must get the query it already has, not a fresh empty one.
		const key = `${collection}:${JSON.stringify(input)}`;
		const existing = this.#queries.get(key);
		if (existing) return existing;
		const query = new FakeLiveQuery(() =>
			(this.#rows.get(collection) ?? [])
				.filter((row) => matches(row, input.where))
				.sort((left, right) => compare(left, right, input.orderBy))
				.slice(0, input.limit ?? Infinity)
				.map((row) => ({ ...row }))
		);
		this.#queries.set(key, query);
		query.emit();
		return query;
	}

	#refire(collection: string): void {
		for (const [key, query] of this.#queries) {
			if (key.startsWith(`${collection}:`)) query.emit();
		}
	}
}
