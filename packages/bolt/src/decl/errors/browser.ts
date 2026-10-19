import { Schema } from 'effect';

/** The browser's request failed below the protocol (no answer, or an answer that is no JSON); `status` is HTTP's. */
export class TransportFailed
	extends /*#__PURE__*/ Schema.TaggedError<TransportFailed>()('TransportFailed', {
		status: Schema.Number
	})
{
	readonly message = `the request failed (${this.status})`;
}

/** An answer that is not the protocol's shape. */
export class ProtocolFailed
	extends /*#__PURE__*/ Schema.TaggedError<ProtocolFailed>()('ProtocolFailed', {
		message: Schema.String
	}) {}

/** Describing a filter took longer than the client waits. */
export class DescribeTimeout
	extends /*#__PURE__*/ Schema.TaggedError<DescribeTimeout>()('DescribeTimeout', {})
{
	readonly message = 'Describing this filter took too long. Try again.';
}
