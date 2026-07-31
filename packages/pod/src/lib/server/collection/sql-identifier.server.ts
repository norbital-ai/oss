/**
 * The one way to put an identifier into hand-written SQL on the server.
 *
 * There were four of these, under two names, with two different meanings. Two escaped embedded
 * quotes (`"` → `""`) and accepted anything; two rejected anything outside `[a-z_][a-z0-9_]*`.
 * Both are defensible in isolation and it is not defensible to have both: the escaping pair
 * quietly accept identifiers the rejecting pair refuse, so whether a name is safe depended on
 * which file happened to build the statement.
 *
 * This is the strict one, because of where these names come from. Every identifier reaching hand
 * written SQL here is a collection or column name out of the tenant manifest — author-controlled
 * input, generated from a workspace someone can edit. Escaping makes a hostile name *safe*;
 * rejecting makes it *visible*. A collection that cannot be addressed should fail loudly at the
 * boundary, not become a correctly-quoted surprise deep inside a query.
 *
 * Drizzle parameterises its own identifiers and needs none of this. Reach for it only on the paths
 * that must be raw SQL — the approval terminal transition, the outbox tailer, the change feed —
 * where `set_config`, `FOR UPDATE` and temporal-history restore have no Drizzle expression.
 */

/** Postgres unquoted-identifier shape: a letter or underscore, then letters, digits, underscores. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

export function isSafeSqlIdentifier(identifier: string): boolean {
	return SAFE_IDENTIFIER.test(identifier);
}

/**
 * Quote a table or column name, or throw.
 *
 * Throws a plain `Error` rather than an HTTP error on purpose: this is a programming-or-schema
 * fault, not a request the caller could have made differently, and the layers above already turn
 * an unexpected throw into `INTERNAL_ERROR` without leaking internals into user copy.
 */
export function quoteSqlIdentifier(identifier: string): string {
	if (!isSafeSqlIdentifier(identifier)) {
		throw new Error(`Unsafe SQL identifier: ${identifier}`);
	}
	return `"${identifier}"`;
}
