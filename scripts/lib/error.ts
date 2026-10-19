import { Schema } from 'effect';
export class PublicationFailed extends Schema.TaggedError<PublicationFailed>()(
	'PublicationFailed',
	{ message: Schema.String }
) {
	static from(cause: unknown): PublicationFailed {
		return cause instanceof PublicationFailed
			? cause
			: new PublicationFailed({ message: cause instanceof Error ? cause.message : String(cause) });
	}
}
