import { Effect, Schedule, Schema, Stream } from 'effect';
import { Sse } from 'effect/encoding';
import { FacilityFailure } from '../decl/errors.ts';
import {
	CONVERT_TARGETS,
	LIMITS,
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

export function documentConverter(
	config: DocumentConverterConfig
): Convert['Service'] & Required<Pick<Convert['Service'], 'previewPdf'>> {
	const input = (source: Parameters<Convert['Service']['convert']>[0]) =>
		'markdown' in source
			? { from: 'markdown', source: source.markdown }
			: 'layoutHtml' in source
				? { from: 'layout-html', source: source.layoutHtml }
				: { from: 'html', source: source.html };
	return {
		targets: CONVERT_TARGETS,
		previewPdf: (source, options) =>
			Port.attempt('convert', async (signal) => {
				const response = await (config.fetch ?? fetch)(
					`${config.url.replace(/\/$/, '')}/v1/convert/preview`,
					{
						method: 'POST',
						signal,
						headers: {
							authorization: `Bearer ${config.key}`,
							'content-type': 'application/json'
						},
						body: JSON.stringify({ ...input(source), ...options, to: 'pdf' })
					}
				);
				if (
					!response.ok ||
					response.headers.get('content-type') !== 'application/pdf' ||
					Number(response.headers.get('content-length')) > LIMITS.crossingBytes
				) {
					await response.body?.cancel();
					throw new Error(`The PDF preview service answered ${response.status}.`);
				}
				return new Uint8Array(await response.arrayBuffer());
			}),
		convert: (source, to, options) =>
			submit(
				config,
				'/v1/convert',
				{
					...input(source),
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
const WireResult = Schema.fromJsonString(WireIngest);
const settled = (job: typeof Job.Type) => job.state === 'succeeded' || job.state === 'failed';

/** How often a waiting ingest asks after its job: at once for a short read, rarely in a long queue. */
const POLL = { firstMs: 100, growth: 1.5, lastMs: 5000 };
/**
 * One ingest over Convert's job routes: a long document's answer is far past what one SSE event may hold, so it is
 * fetched whole once the job ends. A 415 answers `{ unsupported }`, a 503 `{ unavailable }`.
 */
const ingestJob = (
	config: DocumentConverterConfig,
	file: { readonly name: string; readonly mime: string; readonly sha256?: string; readonly lane?: string },
	bytes: Uint8Array | ReadableStream<Uint8Array>,
	options: object
) =>
	Effect.gen(function* () {
		const fetcher = config.fetch ?? fetch,
			base = config.url.replace(/\/$/, ''),
			headers = { authorization: `Bearer ${config.key}` };
		const answered = (response: Response) =>
			response.ok
				? Effect.void
				: Effect.fail(failure(new Error(`the converter answered ${response.status}`)));
		const job = (response: Response) =>
			Effect.tryPromise({ try: () => response.json(), catch: failure }).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Job)),
				Effect.mapError(failure)
			);
		// a file read from Convert's disk stays there a while: a page of it does not send it all again
		const sha256 =
			file.sha256 !== undefined && ('page' in options || 'pictures' in options)
				? file.sha256
				: undefined;
		const kept =
			sha256 !== undefined &&
			(yield* Port.attempt('convert', (signal) =>
				fetcher(`${base}/v1/kept/${sha256}`, { headers, signal })
			).pipe(Effect.map((response) => response.ok)));
		const body = kept ? new Uint8Array() : bytes;
		if (kept && bytes instanceof ReadableStream)
			yield* Port.attempt('convert', () => bytes.cancel());
		const query = new URLSearchParams({
			name: file.name,
			mime: file.mime,
			options: JSON.stringify(options),
			...(sha256 === undefined ? {} : { sha256 }),
			...(file.lane === undefined ? {} : { lane: file.lane })
		});
		const posted = yield* Port.attempt('convert', (signal) =>
			fetcher(`${base}/v1/ingest/raw?${query}`, {
				method: 'POST',
				signal,
				headers: { ...headers, 'content-type': 'application/octet-stream' },
				...(body instanceof Uint8Array
					? { body: new Uint8Array(body) }
					: // a streamed request body is half duplex (Node requires saying so)
						Object.assign({ body }, { duplex: 'half' }))
			})
		);
		if (posted.status === 415 || posted.status === 503) {
			const refusal = yield* Effect.tryPromise({ try: () => posted.json(), catch: failure }).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Refusal)),
				Effect.mapError(failure)
			);
			return posted.status === 415
				? { unsupported: refusal.message }
				: { unavailable: refusal.message };
		}
		yield* answered(posted);
		const started = yield* job(posted);
		// a queue under a burst answers in its time: every job asking four times a second would be the burst
		let ended = started;
		for (let wait = POLL.firstMs; !settled(ended); wait = Math.min(wait * POLL.growth, POLL.lastMs)) {
			yield* Effect.sleep(wait);
			ended = yield* Port.attempt('convert', (signal) =>
				fetcher(`${base}/v1/jobs/${started.id}`, { headers, signal })
			).pipe(Effect.tap(answered), Effect.flatMap(job));
		}
		if (ended.state === 'failed')
			return yield* Effect.fail(failure(new Error(ended.error ?? 'the conversion failed')));
		const done = yield* Port.attempt('convert', (signal) =>
			fetcher(`${base}/v1/jobs/${ended.id}/result`, { headers, signal })
		);
		yield* answered(done);
		const text = yield* Effect.tryPromise({ try: () => done.text(), catch: failure });
		return {
			result: yield* Schema.decodeUnknownEffect(WireResult)(text).pipe(Effect.mapError(failure))
		};
	});

/**
 * The `IngestPort` over Norbital Convert's job routes (plan 12): a host constructs it from Convert's URL and key. A
 * converter with no transcription model rejects audio as `unavailable`.
 */
export function documentIngester(config: DocumentConverterConfig): IngestPort {
	return {
		ingest: (file, options, signal) =>
			Effect.runPromise(
				ingestJob(config, file, file.bytes ?? new Uint8Array(), options).pipe(
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
