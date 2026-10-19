import { Option } from 'effect';
import * as Schema from 'effect/Schema';

/** A page read the engine refused: its code and message. */
export class ReadFailed extends Schema.TaggedError<ReadFailed>()('ReadFailed', {
	code: Schema.String,
	message: Schema.String
}) {}

const ReadError = Schema.Struct({
	kind: Schema.Literal('bolt'),
	code: Schema.String,
	message: Schema.String
});
const decodeRead = Schema.decodeUnknownOption(ReadError);

/** The declared-read failure wire value; malformed answers remain engine defects. */
export const readFailure = (error: unknown): Option.Option<ReadFailed> =>
	Option.map(
		decodeRead(error),
		(value) => new ReadFailed({ code: value.code, message: value.message })
	);
