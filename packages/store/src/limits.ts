// The store's caps: every read states its page, and nothing past a cap is clamped — it is refused.
const MiB = 1024 * 1024;
export const STORE_LIMITS = {
	/** A page's `limit` at most; `all` at most this many rows and bytes; a relation list asked for `all` at most this many. */
	page: { max: 10_000, all: 50_000, allBytes: 8 * MiB, relationArm: 10_000 },
	/** A paged read's bytes, counted in the database: a page ends early at the first row past it. */
	pageBytes: 4 * MiB,
	/** One statement binds at most this many parameters. */
	statement: { params: 30_000 },
	/** A `where`'s nesting (`and`/`or`/`not` and relation hops together), a list's items, an `orderBy`'s keys. */
	where: { depth: 16, list: 1_000 },
	orderKeys: 4
} as const;
