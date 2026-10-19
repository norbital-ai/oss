import { Option, Predicate } from 'effect';
import * as Schema from 'effect/Schema';

/** A facility failure's kinds: `tooLarge` and `invalid` pass a provider's own limit refusal through (P37). */
export const FACILITY_KINDS = [
	'upstream',
	'timeout',
	'rateLimited',
	'invalid',
	'tooLarge',
	'unsupported'
] as const;
/** A facility call that failed (`request`, `web`, `files`, `convert`, `ai`): its kind, message and HTTP status. */
export class FacilityFailure extends Schema.TaggedError<FacilityFailure>()('FacilityFailure', {
	kind: Schema.Literals(FACILITY_KINDS),
	message: Schema.String,
	status: Schema.optional(Schema.Number)
}) {}

/** An optional facility with no provider bound (P19), or an instance not paired: the facility and why. */
export class Unavailable extends Schema.TaggedError<Unavailable>()('Unavailable', {
	facility: Schema.String,
	reason: Schema.String
}) {
	readonly message = this.reason;
}

const decodeFacility = Schema.decodeUnknownOption(
	Schema.suspend(() => Schema.Union([FacilityFailure, Unavailable]))
);

/** A facility's failure value (`{ kind, message, status? }` or `{ kind: 'unavailable', facility, reason }`) as its error. */
export const facilityFailure = (error: unknown): Option.Option<FacilityFailure | Unavailable> => {
	const kind =
		Predicate.hasProperty(error, 'kind') && Predicate.isString(error.kind) ? error.kind : undefined;
	return kind === undefined || !Predicate.isObject(error)
		? Option.none()
		: decodeFacility({
				...error,
				_tag: kind === 'unavailable' ? 'Unavailable' : 'FacilityFailure'
			});
};
