// Long recordings are normalized on disk; scoped child processes and handles close on interruption.
import { Effect, FileSystem, Option, Path, Random, Schedule, Schema, Stream } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import type {
	SpeechFormat,
	TranscribeOptions,
	Transcript,
	TranscriptSegment
} from '@norbital-ai/bolt/engine';
import { SpeechFailure } from '../errors.ts';

export type OpenRouterSpeechConfig<E> = {
	apiKey: string;
	/** Default `https://openrouter.ai/api/v1`. */
	baseUrl?: string;
	/** An audio-input chat model with structured output, e.g. `google/gemini-3.5-flash`; absent → no `transcribe`. */
	transcribeModel?: string;
	/** A `/audio/speech` model, e.g. `google/gemini-3.8-flash-tts`; absent → no `speak`. */
	speakModel?: string;
	/** The voice when a call names none (voices are the model's own, e.g. `Kore`). */
	speakVoice?: string;
	/** The ffmpeg binary (default `ffmpeg` on PATH); `false`: never split or convert. */
	ffmpeg?: string | false;
	/** Chunk length and overlap in seconds (default 300 and 15). */
	chunkSeconds?: number;
	overlapSeconds?: number;
	/** The provider's charge for each transcription request, USD, under its id. */
	meter?: (costUsd: number, id: string) => Effect.Effect<void, E>;
};

/** Frames of the normalized stream (MPEG-2 layer III, 16 kHz, 32 kbps, no padding): 576 samples in 144 bytes. */
export const FRAME_BYTES = 144;
const FRAME_S = 0.036;
const MIME: { readonly [F in SpeechFormat]: string } = {
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg'
};
/** OpenRouter's `input_audio.format` by MIME type; anything else needs ffmpeg. */
const FORMATS: { readonly [mime: string]: string } = {
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/wave': 'wav',
	'audio/ogg': 'ogg',
	'audio/flac': 'flac',
	'audio/x-flac': 'flac',
	'audio/aac': 'aac',
	'audio/mp4': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/aiff': 'aiff',
	'audio/x-aiff': 'aiff'
};
const SPEAK_BYTES = 4 * 1024 * 1024;
const ms = (s: number) => Math.round(s * 1000) / 1000;

/** The chunk windows over `duration` seconds: `chunk` long, each starting `overlap` before the previous one ends. */
export function windows(
	duration: number,
	chunk: number,
	overlap: number
): { start: number; end: number }[] {
	if (!(chunk > overlap && overlap >= 0)) throw new Error('a chunk is longer than its overlap');
	const out: { start: number; end: number }[] = [];
	for (let start = 0; ; start += chunk - overlap) {
		const end = Math.min(duration, start + chunk);
		out.push({ start, end });
		if (end >= duration) return out;
	}
}
/** A window as a byte range of the normalized stream, on frame boundaries. */
export const byteRange = (w: { start: number; end: number }) => ({
	from: Math.floor(w.start / FRAME_S) * FRAME_BYTES,
	to: Math.ceil(w.end / FRAME_S) * FRAME_BYTES
});

type Speaker = { label: string; description: string };
const Heard = Schema.Struct({
	language: Schema.NullOr(Schema.String),
	speakers: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
	segments: Schema.Array(
		Schema.Struct({
			speaker: Schema.String,
			start: Schema.Number,
			end: Schema.Number,
			text: Schema.String
		})
	)
});
type Heard = typeof Heard.Type;
const token = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const words = (s: string) => s.split(/\s+/).map(token).filter(Boolean).join(' ');
/** A second-by-second overlap tolerance, and how close to a window edge a segment is cut off by it. */
const EDGE = 0.5;

/**
 * One utterance heard by two chunks, `b` cut off by the first chunk's end and `n` starting with the second: `n` goes on
 * after the longest run of `b`'s last words it repeats; with none, after the share of its words the overlap `heard` holds.
 */
export function splice(b: string, n: string, heard: number): string {
	const bw = b.split(/\s+/).filter(Boolean).map(token),
		nt = n.split(/\s+/).filter(Boolean),
		nw = nt.map(token);
	for (let k = Math.min(bw.length, nw.length); k >= 2; k--) {
		const tail = bw.slice(-k).join(' ');
		for (let j = 0; j + k <= nw.length; j++)
			if (nw.slice(j, j + k).join(' ') === tail) return [b, ...nt.slice(j + k)].join(' ');
	}
	return [b, ...nt.slice(Math.round(nt.length * Math.min(1, Math.max(0, heard))))].join(' ');
}

/**
 * One chunk's segments (absolute seconds) joined onto what came before: the new chunk's labels are mapped to the ones
 * they overlap most in time (else kept when the model reused a known label, else numbered next). The overlap
 * `[next.start, prevEnd]` is cut at the segment boundary nearest its middle, each segment going to the side its middle
 * falls on; when one utterance runs through the whole overlap its two hearings are spliced into one segment.
 */
export function merge(
	before: readonly TranscriptSegment[],
	prevEnd: number,
	next: { start: number; segments: readonly TranscriptSegment[] },
	known: readonly string[]
): { segments: TranscriptSegment[]; labels: Map<string, string> } {
	const lo = next.start,
		hi = prevEnd;
	const shared = (a: TranscriptSegment, b: TranscriptSegment) =>
		Math.max(0, Math.min(a.end, b.end, hi) - Math.max(a.start, b.start, lo));
	const labels = new Map<string, string>(),
		rest: string[] = [];
	for (const label of [...new Set(next.segments.map((s) => s.speaker))]) {
		const votes = new Map<string, number>();
		for (const n of next.segments.filter((s) => s.speaker === label))
			for (const p of before) votes.set(p.speaker, (votes.get(p.speaker) ?? 0) + shared(n, p));
		const [best, time] = [...votes].reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);
		if (time > 0) labels.set(label, best);
		else rest.push(label);
	}
	// unheard in the overlap: a known label keeps itself unless another took it (a swap: it takes a free known one); else new
	const claimed = new Set(labels.values());
	for (const label of rest.filter((l) => known.includes(l) && !claimed.has(l))) {
		labels.set(label, label);
		claimed.add(label);
	}
	for (const label of rest.filter((l) => !labels.has(l))) {
		let to = known.includes(label) ? known.find((k) => !claimed.has(k)) : undefined;
		for (let n = 1; to === undefined; n++)
			if (!claimed.has(`S${n}`) && !known.includes(`S${n}`)) to = `S${n}`;
		labels.set(label, to);
		claimed.add(to);
	}
	const relabel = (s: TranscriptSegment) => ({ ...s, speaker: labels.get(s.speaker) ?? s.speaker });
	const mid = (s: TranscriptSegment) => (s.start + s.end) / 2,
		middle = (lo + hi) / 2;
	const b = before.at(-1),
		at = next.segments.findIndex((s) => s.end > lo + EDGE),
		n = next.segments[at];
	const bounds = [...before.map((s) => s.end), ...next.segments.map((s) => s.start)].filter(
		(t) => t > lo + EDGE && t < hi - EDGE
	);
	if (
		bounds.length === 0 &&
		b !== undefined &&
		n !== undefined &&
		b.end >= hi - EDGE &&
		n.start <= lo + EDGE
	)
		return {
			labels,
			segments: [
				...before.slice(0, -1),
				{
					speaker: b.speaker,
					start: b.start,
					end: n.end,
					text: splice(b.text, n.text, (hi - n.start) / Math.max(EDGE, n.end - n.start))
				},
				...next.segments.slice(at + 1).map(relabel)
			]
		};
	const cut =
		bounds.length === 0
			? middle
			: bounds.reduce((x, t) => (Math.abs(t - middle) < Math.abs(x - middle) ? t : x));
	const kept = before.filter((s) => mid(s) < cut);
	const added = next.segments.filter((s) => mid(s) >= cut).map(relabel);
	const last = kept.at(-1),
		first = added[0];
	if (last !== undefined && first !== undefined && words(last.text) === words(first.text))
		added.shift();
	return { segments: [...kept, ...added], labels };
}

/** The instructions for one chunk: what is known so far, so labels carry across chunks. */
export function instructions(
	o: TranscribeOptions,
	context: { offset: number; speakers: readonly Speaker[]; before: string }
): string {
	const diarize = o.diarize !== false;
	return [
		'Transcribe this audio verbatim, in the language spoken. Answer JSON only, in the given schema.',
		'Split it into segments at each change of speaker or pause, with start and end in seconds from the start of this audio.',
		diarize
			? 'Label each speaker S1, S2, … by voice, and describe each voice in a few words (pitch, accent, role) in `speakers`.'
			: 'Do not tell speakers apart: label every segment S1.',
		...(diarize && o.speakers !== undefined ? [`There are ${o.speakers} speakers.`] : []),
		...(o.language === undefined ? [] : [`The expected language is ${o.language}.`]),
		...(o.prompt === undefined ? [] : [`Context: ${o.prompt}`]),
		...(diarize && context.speakers.length > 0
			? [
					`This audio continues a recording at ${context.offset.toFixed(1)} s. Speakers heard so far — reuse a label when the voice matches, use a new label for a new voice:`,
					...context.speakers.map((s) => `- ${s.label}: ${s.description}`)
				]
			: []),
		...(context.before === ''
			? []
			: [
					`Its first seconds were already heard as (transcribe this audio in full all the same): ${context.before}`
				])
	].join('\n');
}

const ChatAnswer = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	choices: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				message: Schema.optionalKey(Schema.Struct({ content: Schema.optionalKey(Schema.String) }))
			})
		)
	),
	usage: Schema.optionalKey(Schema.Struct({ cost: Schema.optionalKey(Schema.Number) }))
});
export const parseHeard = Effect.fn('Speech.parseHeard')(function* (body: unknown) {
	const answer = yield* Schema.decodeUnknownEffect(ChatAnswer)(body).pipe(
		Effect.mapError(
			() =>
				new SpeechFailure({ kind: 'upstream', message: 'the transcription model answered no text' })
		)
	);
	const content = answer.choices?.[0]?.message?.content;
	if (content === undefined)
		return yield* Effect.fail(
			new SpeechFailure({ kind: 'upstream', message: 'the transcription model answered no text' })
		);
	// the object itself, whatever fence or prose the model wrapped it in; one repair: trailing commas dropped
	const text = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
	const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
	const parsed = yield* json(text).pipe(
		Effect.catch(() => json(text.replace(/,\s*([}\]])/g, '$1'))),
		Effect.mapError(
			() =>
				new SpeechFailure({
					kind: 'upstream',
					message: `the transcription model answered something that is not JSON: ${content.slice(0, 200)}`
				})
		)
	);
	const heard = yield* Schema.decodeUnknownEffect(Heard)(parsed).pipe(
		Effect.mapError(
			() =>
				new SpeechFailure({
					kind: 'upstream',
					message: 'the transcription model answered segments out of the schema'
				})
		)
	);
	return { ...heard, cost: answer.usage?.cost ?? 0, id: answer.id ?? null };
});

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

export type SpeechServices =
	| HttpClient.HttpClient
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| Path.Path;
export type SpeechDef = {
	readonly transcribe?: (
		audio: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array },
		options: TranscribeOptions
	) => Effect.Effect<Transcript, SpeechFailure, SpeechServices>;
	readonly speak?: (
		text: string,
		options: { readonly voice?: string; readonly format: SpeechFormat; readonly language?: string }
	) => Effect.Effect<
		{ readonly bytes: Uint8Array; readonly mime: string },
		SpeechFailure,
		SpeechServices
	>;
};

export function openRouterSpeech<E>(configuration: OpenRouterSpeechConfig<E>): SpeechDef {
	const base = (configuration.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
	const binary = configuration.ffmpeg === false ? null : (configuration.ffmpeg ?? 'ffmpeg');
	const chunk = configuration.chunkSeconds ?? 300,
		overlap = configuration.overlapSeconds ?? 15;
	const schema = Schema.toJsonSchemaDocument(Heard).schema;
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
	const hear = Effect.fn('Speech.hear')(
		function* (model: string, audio: Uint8Array, format: string, prompt: string) {
			const response = yield* post('/chat/completions', {
				model,
				temperature: 0,
				usage: { include: true },
				reasoning: { effort: 'low' },
				response_format: {
					type: 'json_schema',
					json_schema: { name: 'transcript', strict: true, schema }
				},
				messages: [
					{ role: 'system', content: prompt },
					{
						role: 'user',
						content: [
							{
								type: 'input_audio',
								input_audio: { data: Buffer.from(audio).toString('base64'), format }
							}
						]
					}
				]
			});
			const heard = yield* response.json.pipe(
				Effect.mapError(
					() =>
						new SpeechFailure({
							kind: 'upstream',
							message: 'the transcription model answered something that is not JSON'
						})
				),
				Effect.flatMap(parseHeard)
			);
			if (heard.cost > 0 && configuration.meter !== undefined)
				yield* configuration
					.meter(heard.cost, heard.id ?? `transcribe:${yield* Random.nextInt}`)
					.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
			return heard;
		},
		(effect) =>
			effect.pipe(
				Effect.retry({
					schedule: Schedule.exponential('1 second'),
					times: 2,
					while: (error) => error.kind === 'rateLimited' || error.kind === 'upstream'
				})
			)
	);

	const transcribeModel = configuration.transcribeModel;
	const transcribe =
		transcribeModel === undefined
			? undefined
			: (
					audio: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array },
					options: TranscribeOptions
				) =>
					Effect.scoped(
						Effect.gen(function* () {
							const fs = yield* FileSystem.FileSystem,
								path = yield* Path.Path;
							let normalized: string | null = null;
							if (binary !== null) {
								const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-speech-' });
								const source = path.join(directory, 'in'),
									output = path.join(directory, 'audio.mp3');
								yield* fs.writeFile(source, audio.bytes);
								const converted = yield* ffmpeg(binary, [
									'-i',
									source,
									'-vn',
									'-ac',
									'1',
									'-ar',
									'16000',
									'-c:a',
									'libmp3lame',
									'-b:a',
									'32k',
									'-write_xing',
									'0',
									'-id3v2_version',
									'0',
									'-f',
									'mp3',
									output
								]);
								if (Option.isSome(converted)) normalized = output;
							}
							if (normalized === null) {
								const format = FORMATS[(audio.mime.split(';')[0] ?? '').trim().toLowerCase()];
								if (format === undefined)
									return yield* Effect.fail(
										new SpeechFailure({
											kind: 'unsupported',
											message: `this host cannot read ${audio.mime} audio (it has no ffmpeg)`
										})
									);
								const heard = yield* hear(
									transcribeModel,
									audio.bytes,
									format,
									instructions(options, { offset: 0, speakers: [], before: '' })
								);
								const segments = heard.segments.map((segment) => ({
									...segment,
									speaker: options.diarize === false ? 'S1' : segment.speaker
								}));
								return {
									segments,
									language: heard.language,
									durationMs: Math.round(
										Math.max(0, ...segments.map((segment) => segment.end)) * 1000
									)
								};
							}
							const duration = Number((yield* fs.stat(normalized)).size) / (FRAME_BYTES / FRAME_S);
							if (duration === 0) return { segments: [], language: null, durationMs: 0 };
							const file = yield* fs.open(normalized);
							let segments: TranscriptSegment[] = [],
								speakers: Speaker[] = [],
								language: string | null = null,
								prevEnd = 0;
							const chunks = yield* Effect.try({
								try: () => windows(duration, chunk, overlap),
								catch: () =>
									new SpeechFailure({
										kind: 'invalid',
										message: 'a chunk is longer than its overlap'
									})
							});
							for (const window of chunks) {
								const { from, to } = byteRange(window),
									buffer = new Uint8Array(to - from);
								yield* file.seek(from, 'start');
								const bytesRead = Number(yield* file.read(buffer));
								const before = segments
									.filter((segment) => segment.end > window.start)
									.map((segment) => `${segment.speaker}: ${segment.text}`)
									.join(' ')
									.slice(-1500);
								const heard = yield* hear(
									transcribeModel,
									buffer.subarray(0, bytesRead),
									'mp3',
									instructions(options, { offset: window.start, speakers, before })
								);
								language ??= heard.language;
								const absolute = heard.segments.map((segment) => ({
									...segment,
									speaker: options.diarize === false ? 'S1' : segment.speaker,
									start: ms(Math.min(window.end, window.start + Math.max(0, segment.start))),
									end: ms(Math.min(window.end, window.start + Math.max(0, segment.end)))
								}));
								const merged = merge(
									segments,
									prevEnd,
									{ start: window.start, segments: absolute },
									speakers.map((speaker) => speaker.label)
								);
								segments = merged.segments;
								for (const speaker of heard.speakers) {
									const label = merged.labels.get(speaker.label) ?? speaker.label;
									speakers = [
										...speakers.filter((value) => value.label !== label),
										{ label, description: speaker.description }
									];
								}
								prevEnd = window.end;
							}
							return { segments, language, durationMs: Math.round(duration * 1000) };
						})
					).pipe(
						Effect.mapError((error) =>
							error._tag === 'SpeechFailure'
								? error
								: new SpeechFailure({ kind: 'invalid', message: error.message })
						)
					);
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
	return {
		...(transcribe === undefined ? {} : { transcribe }),
		...(speak === undefined ? {} : { speak })
	};
}
