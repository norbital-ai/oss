import { Schema } from 'effect';
/** A synchronous analyser failure, preserving the source exception. */
export class DoctorFailure extends Schema.TaggedError<DoctorFailure>()('DoctorFailure', {
	message: Schema.String,
	cause: Schema.Defect()
}) {
	constructor(cause: unknown) {
		super({ cause, message: cause instanceof Error ? cause.message : String(cause) });
	}
}
