// The database request driver's bounds (`sqlserver`): one structured program, bounded rows and bytes. The engine checks
// a guest's op before the host's link runs it, and its result after; the connection string never leaves the host.
import * as Schema from 'effect/Schema';
import { SqlServerRequest } from '@norbital-ai/store/sqlserver';
import type { Json } from '../../decl/values.ts';
import { LIMITS } from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';

export const DatabaseRequest = SqlServerRequest;
export type DatabaseRequest = typeof DatabaseRequest.Type;
export type { SqlServerProjection as DatabaseProjection } from '@norbital-ai/store/sqlserver';
export const DatabaseResult = Schema.Struct({
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Json))
});
export type DatabaseResult = typeof DatabaseResult.Type;
export const DATABASE_MAX_ROWS = 1_000;
export const DATABASE_MAX_BYTES = LIMITS.crossingBytes;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function validateDatabaseRequest(value: unknown): DatabaseRequest {
	if (!Schema.is(DatabaseRequest)(value))
		throw BoltError.make('invalidInput', 'admission', 'Invalid database request.');
	if (bytes(value) > LIMITS.argsBytes)
		throw BoltError.make('invalidInput', 'admission', 'Database request exceeds its bounds.');
	return value;
}
export function validateDatabaseResult(
	value: unknown,
	maxRows = DATABASE_MAX_ROWS
): DatabaseResult {
	if (
		!Schema.is(DatabaseResult)(value) ||
		value.rows.length > maxRows ||
		bytes(value) > DATABASE_MAX_BYTES
	)
		throw BoltError.make('overflow', 'facility', 'Database result exceeds its bounds.');
	return value;
}
/** A host's database driver (a request-only link's implementation); it must not expose its connection in answers or errors. */
export interface DatabaseDriver {
	query(credential: Json, request: DatabaseRequest, signal: AbortSignal): Promise<DatabaseResult>;
}
