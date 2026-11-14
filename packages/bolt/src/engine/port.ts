// Secure native identifiers from the host's crypto service. Port calls themselves are `@norbital-ai/host-api`'s `Port`.
import { Crypto, Effect } from 'effect';
import { BoltError } from '../protocol/errors.ts';

/** Secure native identifiers keep the host crypto service's failure as the cause. */
export const uuid = (crypto: Crypto.Crypto) =>
	crypto
		.randomUUIDv4()
		.pipe(
			Effect.mapError((error) =>
				BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
			)
		);
