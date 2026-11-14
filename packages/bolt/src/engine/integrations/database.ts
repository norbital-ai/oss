// The database request driver's bounds (`sqlserver`): one structured program, bounded rows and bytes. The engine checks
// a guest's op before the host's link runs it, and its result after; the connection string never leaves the host.
import * as Schema from 'effect/Schema';
import { Effect } from 'effect';
import {
	DATABASE_MAX_BYTES,
	DATABASE_MAX_ROWS,
	DatabaseRequest,
	DatabaseResult
} from '@norbital-ai/host-api';
import { LIMITS } from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';

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
