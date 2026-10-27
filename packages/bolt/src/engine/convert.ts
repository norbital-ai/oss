import { Effect, Schedule, Schema, Stream } from 'effect';
import { Sse } from 'effect/encoding';
import { FacilityFailure } from '../decl/errors.ts';
import { CONVERT_TARGETS } from './contracts.ts';
import { Convert } from './ports.ts';
import { fromBase64, toBase64 } from './crypto.ts';
import { Port } from './port.ts';

export type DocumentConverterConfig = {
	readonly url: string;
	readonly key: string;
	readonly fetch?: typeof fetch | undefined;
};
const Job = Schema.Struct({
	id: Schema.String,
	state: Schema.Literals(['queued', 'running', 'succeeded', 'failed']),
	error: Schema.NullOr(Schema.String)
});
const Result = Schema.Struct({ bytes: Schema.String });
type Seen = { job?: typeof Job.Type | undefined; bytes?: Uint8Array | undefined };
const failure = (error: unknown) =>
	new FacilityFailure({
		kind: 'upstream',
		message: error instanceof Error ? error.message : 'the converter failed'
	});

export function documentConverter(config: DocumentConverterConfig): Convert['Service'] {
	const fetcher = config.fetch ?? fetch,
		base = config.url.replace(/\/$/, ''),
		headers = { authorization: `Bearer ${config.key}` };
	const read = (response: Response, seen: Seen) =>
		Effect.gen(function* () {
			if (!response.ok || response.body === null)
				return yield* Effect.fail(failure(new Error(`the converter answered ${response.status}`)));
			yield* Stream.fromReadableStream({
				evaluate: () => response.body ?? new ReadableStream(),
				onError: failure
			}).pipe(
				Stream.decodeText(),
				Stream.pipeThroughChannel(Sse.decode()),
				Stream.mapError(failure),
				Stream.runForEach((event) =>
					Effect.gen(function* () {
						if (event.event === 'job')
							seen.job = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Job))(
								event.data
							).pipe(Effect.mapError(failure));
						else if (event.event === 'result') {
							const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Result))(
								event.data
							).pipe(Effect.mapError(failure));
							seen.bytes = fromBase64(result.bytes);
						}
					})
				)
			);
		});
	return {
		targets: CONVERT_TARGETS,
		convert: (source, to, options) =>
			Effect.gen(function* () {
				const seen: Seen = {};
				const body = {
					...('markdown' in source
						? { from: 'markdown', source: source.markdown }
						: { from: 'html', source: source.html }),
					to,
					...(options.page === undefined ? {} : { page: options.page }),
					...(options.landscape === undefined ? {} : { landscape: options.landscape }),
					...(options.reference === undefined ? {} : { reference: toBase64(options.reference) })
				};
				yield* Port.attempt('convert', (signal) =>
					fetcher(`${base}/v1/convert`, {
						method: 'POST',
						signal,
						headers: { ...headers, 'content-type': 'application/json' },
						body: JSON.stringify(body)
					})
				).pipe(
					Effect.flatMap((response) => read(response, seen)),
					Effect.catch((error) =>
						seen.job === undefined ? Effect.fail(error) : Effect.logWarning(error)
					)
				);
				if (seen.job === undefined && seen.bytes === undefined)
					return yield* Effect.fail(failure(new Error('the converter returned no job')));
				yield* Effect.gen(function* () {
					if (seen.bytes !== undefined || seen.job?.state === 'failed') return;
					const job = seen.job;
					if (job === undefined)
						return yield* Effect.fail(failure(new Error('the converter returned no job')));
					const again: Seen = {};
					yield* Port.attempt('convert', (signal) =>
						fetcher(`${base}/v1/jobs/${job.id}/events?result`, { headers, signal })
					).pipe(
						Effect.flatMap((response) => read(response, again)),
						Effect.catch((error) => Effect.logWarning(error))
					);
					if (again.job !== undefined) seen.job = again.job;
					if (again.bytes !== undefined) seen.bytes = again.bytes;
				}).pipe(
					Effect.repeat({
						schedule: Schedule.spaced('250 millis'),
						until: () => seen.bytes !== undefined || seen.job?.state === 'failed'
					})
				);
				return seen.bytes === undefined
					? yield* Effect.fail(failure(new Error(seen.job?.error ?? 'the conversion failed')))
					: seen.bytes;
			})
	};
}
