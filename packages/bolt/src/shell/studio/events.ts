import { Cause, Effect, Queue, Schema, Stream } from 'effect';
import { based, SHELL } from '../nav.ts';
import { PHASES, type StudioFrame } from './model.ts';

class StudioStreamFailed extends Schema.TaggedError<StudioStreamFailed>()('StudioStreamFailed', {
	message: Schema.String
}) {}
const FrameSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('log'),
		line: Schema.Struct({
			at: Schema.String,
			level: Schema.Literals(['info', 'warn', 'error']),
			message: Schema.String
		})
	}),
	Schema.Struct({ kind: Schema.Literal('source'), commit: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('change'), id: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('tests'), commit: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal('phase'),
		phase: Schema.Literals(PHASES),
		state: Schema.Literals(['running', 'done', 'failed'])
	})
]);
export const studio_events = (url = based(`${SHELL}/studio/events`)) =>
	Stream.callback<StudioFrame, StudioStreamFailed>((queue) =>
		Effect.acquireRelease(
			Effect.try({
				try: () => new EventSource(url, { withCredentials: true }),
				catch: () => new StudioStreamFailed({ message: 'Studio events could not be opened.' })
			}),
			(source) => Effect.sync(() => source.close())
		).pipe(
			Effect.tap((source) =>
				Effect.sync(() => {
					source.onmessage = (event: MessageEvent<unknown>) => {
						const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(FrameSchema))(
							event.data
						);
						if (decoded._tag === 'Success') Queue.offerUnsafe(queue, decoded.success);
						else
							Queue.failCauseUnsafe(
								queue,
								Cause.fail(new StudioStreamFailed({ message: 'Studio returned an invalid event.' }))
							);
					};
				})
			)
		)
	);
