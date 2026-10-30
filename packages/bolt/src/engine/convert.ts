import { Effect, Schedule, Schema, Stream } from 'effect';
import { Sse } from 'effect/encoding';
import { FacilityFailure } from '../decl/errors.ts';
import {
	CONVERT_TARGETS,
	type FacilityError,
	type Ingested,
	type IngestPort
} from './contracts.ts';
import { ingestAnswer, type Convert } from './ports.ts';
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
const Refusal = Schema.Struct({ error: Schema.String, message: Schema.String });
type Seen<A> = { job?: typeof Job.Type | undefined; result?: A | undefined };
const failure = (error: unknown) =>
	new FacilityFailure({
		kind: 'upstream',
		message: error instanceof Error ? error.message : 'the converter failed'
	});

/**
 * One Convert job over its SSE route: `job` events, then `result` decoded by `Result`. A stream cut after the job's first
 * event resumes from `/v1/jobs/<id>/events?result` until the job settles. A 415 answers `{ unsupported }`, a 503
 * `{ unavailable }`.
 */
const submit = <A>(
	config: DocumentConverterConfig,
	path: string,
	body: unknown,
	Result: Schema.Decoder<A>
) =>
	Effect.gen(function* () {
		const fetcher = config.fetch ?? fetch,
			base = config.url.replace(/\/$/, ''),
			headers = { authorization: `Bearer ${config.key}` };
		const read = (response: Response, seen: Seen<A>) =>
			Effect.gen(function* () {
				if (!response.ok || response.body === null)
					return yield* Effect.fail(
						failure(new Error(`the converter answered ${response.status}`))
					);
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
							else if (event.event === 'result')
								seen.result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Result))(
									event.data
								).pipe(Effect.mapError(failure));
						})
					)
				);
			});
		const seen: Seen<A> = {};
		let unsupported: string | undefined, unavailable: string | undefined;
		yield* Port.attempt('convert', (signal) =>
			fetcher(`${base}${path}`, {
				method: 'POST',
				signal,
				headers: { ...headers, 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		).pipe(
			Effect.flatMap((response) =>
				response.status === 415 || response.status === 503
					? Effect.tryPromise({ try: () => response.json(), catch: failure }).pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Refusal)),
							Effect.mapError(failure),
							Effect.map((refusal) => {
								if (response.status === 415) unsupported = refusal.message;
								else unavailable = refusal.message;
							})
						)
					: read(response, seen)
			),
			Effect.catch((error) =>
				seen.job === undefined ? Effect.fail(error) : Effect.logWarning(error)
			)
		);
		if (unsupported !== undefined) return { unsupported };
		if (unavailable !== undefined) return { unavailable };
		if (seen.job === undefined && seen.result === undefined)
			return yield* Effect.fail(failure(new Error('the converter returned no job')));
		yield* Effect.gen(function* () {
			if (seen.result !== undefined || seen.job?.state === 'failed') return;
			const job = seen.job;
			if (job === undefined)
				return yield* Effect.fail(failure(new Error('the converter returned no job')));
			const again: Seen<A> = {};
			yield* Port.attempt('convert', (signal) =>
				fetcher(`${base}/v1/jobs/${job.id}/events?result`, { headers, signal })
			).pipe(
				Effect.flatMap((response) => read(response, again)),
				Effect.catch((error) => Effect.logWarning(error))
			);
			if (again.job !== undefined) seen.job = again.job;
			if (again.result !== undefined) seen.result = again.result;
		}).pipe(
			Effect.repeat({
				schedule: Schedule.spaced('250 millis'),
				until: () => seen.result !== undefined || seen.job?.state === 'failed'
			})
		);
		return seen.result === undefined
			? yield* Effect.fail(failure(new Error(seen.job?.error ?? 'the conversion failed')))
			: { result: seen.result };
	});

export function documentConverter(config: DocumentConverterConfig): Convert['Service'] {
	return {
		targets: CONVERT_TARGETS,
		convert: (source, to, options) =>
			submit(
				config,
				'/v1/convert',
				{
					...('markdown' in source
						? { from: 'markdown', source: source.markdown }
						: { from: 'html', source: source.html }),
					to,
					...(options.page === undefined ? {} : { page: options.page }),
					...(options.landscape === undefined ? {} : { landscape: options.landscape }),
					...(options.reference === undefined ? {} : { reference: toBase64(options.reference) })
				},
				Schema.Struct({ bytes: Schema.String })
			).pipe(
				Effect.flatMap((answer) =>
					'result' in answer
						? Effect.succeed(fromBase64(answer.result.bytes))
						: Effect.fail(
								failure(
									new Error('unsupported' in answer ? answer.unsupported : answer.unavailable)
								)
							)
				)
			)
	};
}

const WireIngest = ingestAnswer(Schema.Uint8ArrayFromBase64);

/**
 * The `IngestPort` over Norbital Convert's `/v1/ingest` (plan 12): a host constructs it from Convert's URL and key. A
 * converter with no transcription model rejects audio as `unavailable`.
 */
export function documentIngester(config: DocumentConverterConfig): IngestPort {
	return {
		ingest: (file, options, signal) =>
			Effect.runPromise(
				submit(
					config,
					'/v1/ingest',
					{ name: file.name, mime: file.mime, bytes: toBase64(file.bytes), options },
					WireIngest
				).pipe(
					Effect.flatMap(
						(answer): Effect.Effect<Ingested | { readonly unsupported: string }, FacilityError> =>
							'result' in answer
								? Effect.succeed(answer.result)
								: 'unsupported' in answer
									? Effect.succeed({ unsupported: answer.unsupported })
									: // the port ABI's thrown FacilityError (`Port.fromPromise` answers it as `Unavailable`)
										Effect.fail({
											kind: 'unavailable',
											facility: 'convert.ingest',
											reason: answer.unavailable
										})
					)
				),
				{ signal }
			)
	};
}
