import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { Effect, Record as EffectRecord } from 'effect';
import { AUTH_MODELS, SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';

/**
 * Better Auth over a host facility, through Drizzle.
 *
 * Better Auth ships adapters for Drizzle, Kysely and a raw Postgres pool, and every one of them
 * wants a connection bolt does not have and must not have: a bolt is a stateless bundle that
 * reaches state only through the facilities its host binds. That constraint used to be met by
 * hand-writing an adapter whose entire I/O was `execute` — a query builder, a where compiler and a
 * column mapper, all restating what Drizzle already knows, and all of it ours to get wrong. It was
 * wrong twice in one afternoon: `supportsDates` sent real `Date` objects across a seam whose
 * parameters are `Schema.Json` and every timestamped statement failed, and because `sendCode`
 * swallows failure by contract, a sign-in code was never stored and nothing said so.
 *
 * `drizzle-orm/pg-proxy` removes the dilemma rather than splitting it. It is a Drizzle driver whose
 * transport is a callback, so Drizzle composes the SQL and Better Auth's own `drizzleAdapter` maps
 * the models, while the only thing crossing the boundary is still a string and an array of
 * parameters. Bolt stays connection-free and host-agnostic — the same bundle authenticates
 * against Colony's Neon branch, bolt-server's Postgres, or a test's in-memory tables — and the
 * tables are declared as Drizzle tables, the same way collections are.
 */

/**
 * One statement emitted by Better Auth's Drizzle adapter.
 *
 * The SQL text is not an application authoring surface: `makeAuthStore` constructs this value only
 * inside the proxy callback after Drizzle has rendered an adapter operation. Keeping it bundled
 * makes that provenance explicit at the facility seam and prevents identity callers from growing a
 * general `(sql, parameters)` helper beside the model-backed persistence composer.
 */
type AdapterStatement = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<unknown>;
}>;

/** The one generated-statement capability this adapter needs from its host. */
export type ExecuteQuery = (statement: AdapterStatement) => Effect.Effect<
	{
		readonly rows: ReadonlyArray<Record<string, unknown>>;
		readonly affectedRows: number;
	},
	unknown
>;

/**
 * Drizzle's proxy driver wants positional rows; a facility answers with named ones.
 *
 * Drizzle composed the statement, so it knows what it selected and maps the values back by position.
 * `Object.values` is the whole conversion because a Postgres driver builds each row object in the
 * result's own column order — the same order Drizzle is expecting to read.
 */
const positional = (rows: ReadonlyArray<Record<string, unknown>>): Array<Array<unknown>> =>
	rows.map((row) => Object.values(row));

/** Better Auth's required Drizzle view, selected from the canonical compiled system models. */
const authSchema = Object.freeze(
	EffectRecord.mapEntries(AUTH_MODELS, (name) => [name, SYSTEM_MODEL_TABLES[name]])
);

export const makeAuthStore = (execute: ExecuteQuery) => {
	const database = drizzle((sql, parameters, method) =>
		Effect.runPromise(
			execute({ sql, parameters }).pipe(
				Effect.map((result) => ({
					// `execute` asks for the driver's own result shape; `all` asks for rows to map. Only
					// the latter is positional, and returning arrays for both is what makes `returning()`
					// come back as a list of undefined columns.
					rows: method === 'all' ? positional(result.rows) : [...result.rows]
				}))
			)
		)
	);
	return drizzleAdapter(database, {
		provider: 'pg',
		schema: authSchema,
		// The tables are named exactly as Better Auth's `modelName` options name them, so the adapter
		// must look them up by that name rather than pluralising or re-deriving one.
		usePlural: false,
		debugLogs: false
	});
};
