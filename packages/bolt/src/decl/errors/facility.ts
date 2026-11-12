import { Option, Predicate } from 'effect';
import * as Schema from 'effect/Schema';

/** A facility failure's kinds: `too_large` and `invalid` pass a provider's own limit refusal through (P37). */
export const FACILITY_KINDS = [
	'upstream',
	'timeout',
	'rate_limited',
	'invalid',
	'too_large',
	'unsupported'
] as const;
/** A failed facility call: its kind, message, HTTP status and optional provider retry delay. */
export class FacilityFailure extends Schema.TaggedError<FacilityFailure>()('FacilityFailure', {
	kind: Schema.Literals(FACILITY_KINDS),
	message: Schema.String,
	status: Schema.optional(Schema.Number),
	/** The provider's minimum delay before another attempt. */
	retry_after_ms: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))
}) {
	/** Refuses invalid facility input without changing the shared tagged error identity. */
	static invalid(message: string): FacilityFailure {
		return new FacilityFailure({ kind: 'invalid', message });
	}
}

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
