// The tenant database a host serves: SQL statements with JSON parameters, answered as JSON rows. A host implements it
// once as Effects (`RawDb`, its own driver) and hands a release the Promise form (`HostTenantDb`).
import type { Effect, Schema } from 'effect';
import type { DbError } from './errors.ts';
import type { Json } from '@norbital-ai/store';

/** One statement with positional parameters (`$1…`); values are JSON (numeric, timestamps and dates as strings). */
export type Sql = { readonly text: string; readonly params: readonly Json[] };
/** A statement's result: its rows as JSON column maps and the number of rows it affected. */
export type Rows = {
	readonly rows: readonly { readonly [column: string]: Json }[];
	readonly affected: number;
};
/** Taken before the statement, in sorted order; advisory keys are hashed by the adapter (`pg_advisory_xact_lock`). */
export type Lock = {
	tables?: readonly string[];
	mode?: 'SHARE ROW EXCLUSIVE';
	advisory?: readonly string[];
};
/** Complete database work, prepared before a connection is acquired; no application callback runs inside it. */
export type DbBatch = {
	readonly statements: readonly Sql[];
	readonly lock?: Lock;
	/** Native dry-run: execute and answer the statements, then roll back all of their effects. */
	readonly rollback?: true;
};
/** What a host's database adapter implements, as Effects failing with the driver's `DbError`. */
export type RawDb = {
	/** Read statements share one snapshot and answer in order; rows are relayed as JSON (D5). */
	readonly read: (statements: readonly Sql[]) => Effect.Effect<readonly Rows[], DbError>;
	/** An act's one write statement, with fixed deadlines and native locks before execution. */
	readonly write: (statement: Sql, lock?: Lock) => Effect.Effect<Rows, DbError>;
	/** Complete SQL statements atomically; answers are decoded only after commit or native dry-run rollback. */
	readonly transaction: (batch: DbBatch) => Effect.Effect<readonly Rows[], DbError>;
};
/** The tenant database as a release reaches it: `RawDb` as Promise calls, a failure an encoded `DbError`. */
export type HostTenantDb = {
	read(statements: readonly Sql[], signal?: AbortSignal): Promise<readonly Rows[]>;
	write(statement: Sql, lock?: Lock, signal?: AbortSignal): Promise<Rows>;
	transaction(batch: DbBatch, signal?: AbortSignal): Promise<readonly Rows[]>;
};
