import { Option, Predicate } from 'effect';
import * as Schema from 'effect/Schema';
import { FacilityFailure, Unavailable } from '@norbital-ai/host-api';

const decodeFacility = Schema.decodeUnknownOption(Schema.Union([FacilityFailure, Unavailable]));

/** A facility's failure value (`{ kind, message, status? }` or `{ kind: 'unavailable', facility, reason }`) as its error. */
export const facility_failure = (error: unknown): Option.Option<FacilityFailure | Unavailable> => {
	const kind =
		Predicate.hasProperty(error, 'kind') && Predicate.isString(error.kind) ? error.kind : undefined;
	return kind === undefined || !Predicate.isObject(error)
		? Option.none()
		: decodeFacility({
				...error,
				_tag: kind === 'unavailable' ? 'Unavailable' : 'FacilityFailure'
			});
};
