// The database request driver's bounds (`sqlserver`): one structured program, bounded rows and bytes. The engine checks
// a guest's op before the host's link runs it, and its result after; the connection string never leaves the host.
import * as Schema from 'effect/Schema';
import { Effect } from 'effect';
import { SqlServerRequest } from '@norbital-ai/store/sqlserver';
import type { Json } from '../../decl/values.ts';
import { LIMITS } from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';

/**
 * Schema of one structured database program a guest sends through a database link (today the SQL Server shape):
 * `values`, `read`, `call`, CDC metadata and pages, and `insert_once`. The workspace names qualified tables, projected
 * columns, filters, decimal/date formats and its delete policy; the host compiles the native SQL. CDC pages reconcile
 * current rows and tombstones from an inclusive LSN/sequence/operation/key cursor. `insert_once` takes an immutable
 * key and fingerprint, a five-second native lock and one serializable header/child/procedure batch, and answers an
 * exact receipt; `call` names a procedure with typed arguments over native RPC. Cancellation, row and byte bounds, TLS
 * identity and network admission apply to every program.
 * @example
 * yield* ctx.request(erp, { op: 'read', table: { schema: 'accounting', name: 'products' }, columns: ['code', 'name'],
 * 	where: { active: true }, max_rows: 100 });
 */
export const DatabaseRequest = SqlServerRequest;
export type DatabaseRequest = typeof DatabaseRequest.Type;
/** Schema of a database link's answer: its rows as JSON column maps. */
export const DatabaseResult = Schema.Struct({
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Json))
});
export type DatabaseResult = typeof DatabaseResult.Type;
/** Default most rows a database result may carry; more fails `overflow`, never a truncation. */
export const DATABASE_MAX_ROWS = 1_000;
/** Most JSON bytes a database result may carry (the crossing limit); more fails `overflow`. */
export const DATABASE_MAX_BYTES = LIMITS.crossingBytes;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Decodes a guest's database request, refusing unknown keys or one over the argument byte limit as `invalid_input`. */
export const validate_database_request = (
	value: unknown
): Effect.Effect<DatabaseRequest, BoltError> =>
	Schema.decodeUnknownEffect(DatabaseRequest)(value, { onExcessProperty: 'error' }).pipe(
		Effect.mapError(() => BoltError.make('invalid_input', 'admission', 'Invalid database request.')),
		Effect.flatMap((request) =>
			bytes(value) > LIMITS.argsBytes
				? Effect.fail(BoltError.make('invalid_input', 'admission', 'Database request exceeds its bounds.'))
				: Effect.succeed(request)
		)
	);
export const validate_database_result = (
	value: unknown,
	maxRows = DATABASE_MAX_ROWS
): Effect.Effect<DatabaseResult, BoltError> =>
	Schema.is(DatabaseResult)(value) &&
	value.rows.length <= maxRows &&
	bytes(value) <= DATABASE_MAX_BYTES
		? Effect.succeed(value)
		: Effect.fail(BoltError.make('overflow', 'facility', 'Database result exceeds its bounds.'));
/** A host's database driver (a request-only link's implementation); it must not expose its connection in answers or errors. */
export interface DatabaseDriver {
	query(credential: Json, request: DatabaseRequest, signal: AbortSignal): Promise<DatabaseResult>;
}
