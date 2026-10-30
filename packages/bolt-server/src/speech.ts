// Text to speech over OpenRouter; ffmpeg encodes mp3 and ogg in a scoped child process that closes on interruption.
import { Effect, Option, Schema, Stream } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import type { SpeechFormat } from '@norbital-ai/bolt/engine';

/** A speech call failed; the engine answers it as the facility failure of `kind`. */
export class SpeechFailure extends Schema.TaggedError<SpeechFailure>()('SpeechFailure', {
	kind: Schema.Literals([
		'upstream',
		'timeout',
		'rateLimited',
		'invalid',
		'tooLarge',
		'unsupported'
	]),
	message: Schema.String,
	status: Schema.optional(Schema.Number)
}) {}

export type OpenRouterSpeechConfig = {
	apiKey: string;
	/** Default `https://openrouter.ai/api/v1`. */
	baseUrl?: string;
	/** A `/audio/speech` model, e.g. `google/gemini-3.8-flash-tts`; absent → no `speak`. */
	speakModel?: string;
	/** The voice when a call names none (voices are the model's own, e.g. `Kore`). */
	speakVoice?: string;
	/** The ffmpeg binary (default `ffmpeg` on PATH); `false`: wav only. */
	ffmpeg?: string | false;
};

const MIME: { readonly [F in SpeechFormat]: string } = {
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg'
};
const SPEAK_BYTES = 4 * 1024 * 1024;
const concatenate = (chunks: readonly Uint8Array[]) => {
	const out = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
};
const collect = (stream: Stream.Stream<Uint8Array, SpeechFailure>, limit: number) =>
	stream.pipe(
		Stream.runFoldEffect(
			(): { chunks: Uint8Array[]; size: number } => ({ chunks: [], size: 0 }),
			(state, chunk) => {
				const size = state.size + chunk.byteLength;
				return size > limit
					? Effect.fail(
							new SpeechFailure({
								kind: 'tooLarge',
								message: 'the audio is larger than 4 MiB; say less at a time'
							})
						)
					: Effect.succeed({ chunks: [...state.chunks, chunk], size });
			}
		),
		Effect.map((state) => concatenate(state.chunks))
	);

const ffmpeg = (
	binary: string,
	args: readonly string[],
	input?: Stream.Stream<Uint8Array, SpeechFailure>
): Effect.Effect<
	Option.Option<Uint8Array>,
	SpeechFailure,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const process = yield* spawner.spawn(
				ChildProcess.make(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
					stdin: input === undefined ? 'ignore' : 'pipe',
					stdout: 'pipe',
					stderr: 'pipe'
				})
			);
			const [bytes, stderr, exit] = yield* Effect.all(
				[
					collect(
						process.stdout.pipe(
							Stream.mapError(
								(error) => new SpeechFailure({ kind: 'invalid', message: error.message })
							)
						),
						SPEAK_BYTES
					),
					process.stderr.pipe(
						Stream.decodeText(),
						Stream.runFold(
							() => '',
							(tail, text) => (tail + text).slice(-2000)
						)
					),
					input === undefined
						? process.exitCode
						: Effect.andThen(Stream.run(input, process.stdin), process.exitCode)
				],
				{ concurrency: 'unbounded' }
			);
			if (exit !== 0)
				return yield* Effect.fail(
					new SpeechFailure({
						kind: 'invalid',
						message: `ffmpeg could not read the audio: ${stderr.trim() || `exit ${exit}`}`
					})
				);
			return Option.some(bytes);
		})
	).pipe(
		Effect.catchTag('PlatformError', (error) =>
			error.reason._tag === 'NotFound'
				? Effect.succeed(Option.none<Uint8Array>())
				: Effect.fail(error)
		),
		Effect.mapError((error) =>
			error._tag === 'SpeechFailure'
				? error
				: new SpeechFailure({
						kind: 'invalid',
						message: `ffmpeg could not read the audio: ${error.message}`
					})
		)
	);

/** 16-bit little-endian PCM as a WAV file. */
export function wav(pcm: Uint8Array, rate: number, channels: number): Uint8Array {
	const out = new Uint8Array(44 + pcm.byteLength),
		v = new DataView(out.buffer);
	const ascii = (at: number, s: string) => {
		for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i);
	};
	ascii(0, 'RIFF');
	v.setUint32(4, 36 + pcm.byteLength, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, channels, true);
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * channels * 2, true);
	v.setUint16(32, channels * 2, true);
	v.setUint16(34, 16, true);
	ascii(36, 'data');
	v.setUint32(40, pcm.byteLength, true);
	out.set(pcm, 44);
	return out;
}

export type SpeechServices = HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner;
export type SpeechDef = {
	readonly speak?: (
		text: string,
		options: { readonly voice?: string; readonly format: SpeechFormat; readonly language?: string }
	) => Effect.Effect<
		{ readonly bytes: Uint8Array; readonly mime: string },
		SpeechFailure,
		SpeechServices
	>;
};

export function openRouterSpeech(configuration: OpenRouterSpeechConfig): SpeechDef {
	const base = (configuration.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
	const binary = configuration.ffmpeg === false ? null : (configuration.ffmpeg ?? 'ffmpeg');
	const post = Effect.fn('Speech.post')(function* (path: string, body: object) {
		const response = yield* HttpClient.execute(
			HttpClientRequest.post(`${base}${path}`, {
				headers: { authorization: `Bearer ${configuration.apiKey}` }
			}).pipe(HttpClientRequest.bodyJsonUnsafe(body))
		).pipe(
			Effect.mapError(
				() => new SpeechFailure({ kind: 'upstream', message: 'OpenRouter request failed' })
			)
		);
		if (response.status >= 400) {
			const reason = (yield* response.text.pipe(Effect.orElseSucceed(() => ''))).slice(0, 500);
			return yield* Effect.fail(
				new SpeechFailure({
					kind:
						response.status === 429
							? 'rateLimited'
							: response.status === 413
								? 'tooLarge'
								: response.status >= 400 && response.status < 500
									? 'invalid'
									: 'upstream',
					message: `OpenRouter refused the request (HTTP ${response.status}): ${reason}`,
					status: response.status
				})
			);
		}
		return response;
	});
	const speakModel = configuration.speakModel;
	const speak =
		speakModel === undefined
			? undefined
			: (
					text: string,
					options: {
						readonly voice?: string;
						readonly format: SpeechFormat;
						readonly language?: string;
					}
				) =>
					Effect.gen(function* () {
						const voice = options.voice ?? configuration.speakVoice;
						if (options.format !== 'wav' && binary === null)
							return yield* Effect.fail(
								new SpeechFailure({
									kind: 'unsupported',
									message: `this host writes speech as wav only (it has no ffmpeg for ${options.format})`
								})
							);
						const response = yield* post('/audio/speech', {
							model: speakModel,
							input: text,
							response_format: 'pcm',
							...(voice === undefined ? {} : { voice })
						});
						const type = response.headers['content-type'] ?? '',
							rate = /rate=(\d+)/.exec(type)?.[1] ?? '24000',
							channels = /channels=(\d+)/.exec(type)?.[1] ?? '1';
						const stream = response.stream.pipe(
							Stream.mapError(
								() =>
									new SpeechFailure({ kind: 'upstream', message: 'OpenRouter answered no audio' })
							)
						);
						if (options.format === 'wav')
							return {
								bytes: wav(
									yield* collect(stream, SPEAK_BYTES - 44),
									Number(rate),
									Number(channels)
								),
								mime: MIME.wav
							};
						if (binary === null)
							return yield* Effect.fail(
								new SpeechFailure({
									kind: 'unsupported',
									message: `this host writes speech as wav only (it has no ffmpeg for ${options.format})`
								})
							);
						const output = yield* ffmpeg(
							binary,
							[
								'-f',
								's16le',
								'-ar',
								rate,
								'-ac',
								channels,
								'-i',
								'pipe:0',
								...(options.format === 'mp3'
									? ['-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3']
									: ['-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg']),
								'pipe:1'
							],
							stream
						);
						if (Option.isNone(output))
							return yield* Effect.fail(
								new SpeechFailure({
									kind: 'unsupported',
									message: `this host writes speech as wav only (it has no ffmpeg for ${options.format})`
								})
							);
						return { bytes: output.value, mime: MIME[options.format] };
					});
	return speak === undefined ? {} : { speak };
}
