// The one SSE writer (B.2): the live stream, an integration instance's status stream and the shell's Studio events are
// each a `Stream` of values answered as `text/event-stream`.
import { Stream } from 'effect';
import * as Sse from 'effect/encoding/Sse';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';

/** A comment line: a proxy closes a connection that stays silent too long. */
const PING = ': ping\n\n';

/**
 * `events` as an event stream: each element one `data:` event of its JSON (with `idOf`, its `id:` too), a `: ping`
 * every 25 s. The response ends with the stream; a client that goes away interrupts it (its finalizers run: a live
 * connection disconnects).
 */
export const sseResponse = <A, E>(
	events: Stream.Stream<A, E>,
	idOf?: (value: A) => string
): HttpServerResponse.HttpServerResponse =>
	HttpServerResponse.stream(
		events.pipe(
			Stream.map((value) =>
				Sse.encoder.write({
					_tag: 'Event',
					event: 'message',
					id: idOf?.(value),
					data: JSON.stringify(value)
				})
			),
			Stream.merge(
				Stream.tick('25 seconds').pipe(
					Stream.drop(1),
					Stream.map(() => PING)
				),
				{ haltStrategy: 'left' }
			),
			Stream.encodeText
		),
		{
			contentType: 'text/event-stream',
			headers: { 'cache-control': 'no-store', 'x-accel-buffering': 'no' }
		}
	);
