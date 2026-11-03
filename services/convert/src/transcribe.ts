// Audio to a diarised transcript through an audio-input chat model (OpenRouter's chat completions, `input_audio`), ported
// from bolt-server's speech facility. ffmpeg normalises the recording to mono 16 kHz 32 kbps mp3; it is heard in 300 s
// chunks overlapping by 15 s, one JSON-schema request each, the speakers so far in the prompt so labels carry, and the
// overlaps merged. A video container is heard from its audio track.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Schedule, Schema } from 'effect';

export type Segment = { speaker: string; start: number; end: number; text: string };
export type Speaker = { label: string; description: string };
export type TranscribeOptions = { diarize?: boolean; language?: string; speakers?: number; prompt?: string };
export type Transcript = { language: string | null; durationMs: number; speakers: Speaker[]; segments: Segment[] };
export type Usage = { calls: string[]; model: string; input: number; output: number; cost: number };
export class TranscribeFailed extends Schema.TaggedError<TranscribeFailed>()('TranscribeFailed', {
	message: Schema.String,
	retry: Schema.Boolean
}) {}

/** Frames of the normalised stream (MPEG-2 layer III, 16 kHz, 32 kbps, no padding): 576 samples in 144 bytes. */
export const FRAME_BYTES = 144;
const FRAME_S = 0.036;
const ms = (s: number) => Math.round(s * 1000) / 1000;

/** The chunk windows over `duration` seconds: `chunk` long, each starting `overlap` before the previous one ends. */
export function windows(duration: number, chunk: number, overlap: number): { start: number; end: number }[] {
	if (!(chunk > overlap && overlap >= 0)) throw new Error('a chunk is longer than its overlap');
	const out: { start: number; end: number }[] = [];
	for (let start = 0; ; start += chunk - overlap) {
		const end = Math.min(duration, start + chunk);
		out.push({ start, end });
		if (end >= duration) return out;
	}
}
/** A window as a byte range of the normalised stream, on frame boundaries. */
export const byteRange = (w: { start: number; end: number }) => ({
	from: Math.floor(w.start / FRAME_S) * FRAME_BYTES,
	to: Math.ceil(w.end / FRAME_S) * FRAME_BYTES
});

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
	before: readonly Segment[],
	prevEnd: number,
	next: { start: number; segments: readonly Segment[] },
	known: readonly string[]
): { segments: Segment[]; labels: Map<string, string> } {
	const lo = next.start,
		hi = prevEnd;
	const shared = (a: Segment, b: Segment) => Math.max(0, Math.min(a.end, b.end, hi) - Math.max(a.start, b.start, lo));
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
		for (let n = 1; to === undefined; n++) if (!claimed.has(`S${n}`) && !known.includes(`S${n}`)) to = `S${n}`;
		labels.set(label, to);
		claimed.add(to);
	}
	const relabel = (s: Segment) => ({ ...s, speaker: labels.get(s.speaker) ?? s.speaker });
	const mid = (s: Segment) => (s.start + s.end) / 2,
		middle = (lo + hi) / 2;
	const b = before.at(-1),
		at = next.segments.findIndex((s) => s.end > lo + EDGE),
		n = next.segments[at];
	const bounds = [...before.map((s) => s.end), ...next.segments.map((s) => s.start)].filter(
		(t) => t > lo + EDGE && t < hi - EDGE
	);
	if (bounds.length === 0 && b !== undefined && n !== undefined && b.end >= hi - EDGE && n.start <= lo + EDGE)
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
		bounds.length === 0 ? middle : bounds.reduce((x, t) => (Math.abs(t - middle) < Math.abs(x - middle) ? t : x));
	const kept = before.filter((s) => mid(s) < cut);
	const added = next.segments.filter((s) => mid(s) >= cut).map(relabel);
	const last = kept.at(-1),
		first = added[0];
	if (last !== undefined && first !== undefined && words(last.text) === words(first.text)) added.shift();
	return { segments: [...kept, ...added], labels };
}

/**
 * One chunk's segments on the recording's clock. The model is asked for times from the chunk's start, but may answer
 * the recording's own times: a chunk whose times all lie at or past its start and reach beyond its length is taken as
 * already absolute (shifting it again would clamp every segment to the chunk's end, losing the chunk).
 */
export const placed = (heard: readonly Segment[], window: { readonly start: number; readonly end: number }): Segment[] => {
	const length = window.end - window.start;
	const absolute =
		window.start > 0 &&
		heard.length > 0 &&
		heard.every((s) => s.start >= window.start - 1) &&
		heard.some((s) => s.end > length + 1);
	const shift = absolute ? 0 : window.start;
	return heard.map((s) => ({
		...s,
		start: ms(Math.min(window.end, Math.max(window.start, shift + Math.max(0, s.start)))),
		end: ms(Math.min(window.end, Math.max(window.start, shift + Math.max(0, s.end))))
	}));
};

/** The instructions for one chunk: what is known so far, so labels carry across chunks. */
export function instructions(o: TranscribeOptions, context: { speakers: readonly Speaker[]; before: string }): string {
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
					'This audio continues a recording; give times from the start of this audio, not of the recording. Speakers heard so far — reuse a label when the voice matches, use a new label for a new voice:',
					...context.speakers.map((s) => `- ${s.label}: ${s.description}`)
				]
			: []),
		...(context.before === ''
			? []
			: [`Its first seconds were already heard as (transcribe this audio in full all the same): ${context.before}`])
	].join('\n');
}

const Heard = Schema.Struct({
	language: Schema.NullOr(Schema.String),
	speakers: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
	segments: Schema.Array(
		Schema.Struct({ speaker: Schema.String, start: Schema.Number, end: Schema.Number, text: Schema.String })
	)
});
const ChatAnswer = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	choices: Schema.optionalKey(
		Schema.Array(Schema.Struct({ message: Schema.optionalKey(Schema.Struct({ content: Schema.optionalKey(Schema.String) })) }))
	),
	usage: Schema.optionalKey(
		Schema.Struct({
			cost: Schema.optionalKey(Schema.Number),
			prompt_tokens: Schema.optionalKey(Schema.Number),
			completion_tokens: Schema.optionalKey(Schema.Number)
		})
	)
});
const SCHEMA = Schema.toJsonSchemaDocument(Heard, { onExcessProperty: 'error' }).schema;
const upstream = (message: string, retry = false) => new TranscribeFailed({ message, retry });

/** One chat answer as heard segments and its usage; the object is taken from whatever fence the model put round it. */
export const parseHeard = Effect.fn('Convert.parseHeard')(function* (body: unknown) {
	const answer = yield* Schema.decodeUnknownEffect(ChatAnswer)(body).pipe(
		Effect.mapError(() => upstream('the transcription model answered no text'))
	);
	const content = answer.choices?.[0]?.message?.content;
	if (content === undefined) return yield* upstream('the transcription model answered no text');
	const text = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
	const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
	const parsed = yield* json(text).pipe(
		Effect.catch(() => json(text.replace(/,\s*([}\]])/g, '$1'))),
		Effect.mapError(() => upstream(`the transcription model answered something that is not JSON: ${content.slice(0, 200)}`))
	);
	const heard = yield* Schema.decodeUnknownEffect(Heard)(parsed).pipe(
		Effect.mapError(() => upstream('the transcription model answered segments out of the schema'))
	);
	return {
		...heard,
		cost: answer.usage?.cost ?? 0,
		input: answer.usage?.prompt_tokens ?? 0,
		output: answer.usage?.completion_tokens ?? 0,
		id: answer.id ?? null
	};
});

const run = (binary: string, args: string[], signal: AbortSignal) =>
	new Promise<string>((resolve, reject) =>
		execFile(binary, args, { signal, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
			error ? reject(new Error(`${binary} could not read the audio: ${stderr.trim() || error.message}`)) : resolve(stdout)
		)
	);

export type TranscriberConfig = {
	baseUrl: string;
	apiKey: string;
	model: string;
	ffmpeg?: string;
	chunkSeconds?: number;
	overlapSeconds?: number;
	fetch?: typeof fetch;
};
export type Transcriber = (
	bytes: Uint8Array,
	options: TranscribeOptions
) => Effect.Effect<{ transcript: Transcript; usage: Usage }, TranscribeFailed>;

export function transcriber(c: TranscriberConfig): Transcriber {
	const base = c.baseUrl.replace(/\/$/, '');
	const chunk = c.chunkSeconds ?? 300,
		overlap = c.overlapSeconds ?? 15;
	const doFetch = c.fetch ?? fetch;
	const hear = (audio: Uint8Array, prompt: string) =>
		Effect.tryPromise({
			try: async (signal) => {
				const response = await doFetch(`${base}/chat/completions`, {
					method: 'POST',
					signal,
					headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
					body: JSON.stringify({
						model: c.model,
						temperature: 0,
						usage: { include: true },
						reasoning: { effort: 'low' },
						response_format: { type: 'json_schema', json_schema: { name: 'transcript', strict: true, schema: SCHEMA } },
						messages: [
							{ role: 'system', content: prompt },
							{
								role: 'user',
								content: [{ type: 'input_audio', input_audio: { data: Buffer.from(audio).toString('base64'), format: 'mp3' } }]
							}
						]
					})
				});
				if (response.status >= 400)
					throw upstream(
						`the transcription model refused the request (HTTP ${response.status}): ${(await response.text()).slice(0, 500)}`,
						response.status === 429 || response.status >= 500
					);
				const body: unknown = await response.json();
				return body;
			},
			catch: (e) => (e instanceof TranscribeFailed ? e : upstream(`the transcription request failed: ${String(e)}`, true))
		}).pipe(
			Effect.flatMap(parseHeard),
			Effect.retry({ schedule: Schedule.exponential('1 second'), times: 2, while: (e) => e.retry })
		);
	const normalise = (bytes: Uint8Array) =>
		Effect.acquireUseRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), 'convert-audio-'))),
			(dir) =>
				Effect.tryPromise({
					try: async (signal) => {
						await writeFile(join(dir, 'in'), bytes);
						await run(
							c.ffmpeg ?? 'ffmpeg',
							['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', join(dir, 'in'), '-vn', '-ac', '1', '-ar', '16000',
								'-c:a', 'libmp3lame', '-b:a', '32k', '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3', join(dir, 'audio.mp3')],
							signal
						);
						return readFile(join(dir, 'audio.mp3'));
					},
					catch: (e) => upstream(e instanceof Error ? e.message : String(e))
				}),
			(dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
		);
	return Effect.fn('Convert.transcribe')(function* (bytes: Uint8Array, options: TranscribeOptions) {
		const audio = yield* normalise(bytes);
		const duration = audio.byteLength / (FRAME_BYTES / FRAME_S);
		let segments: Segment[] = [],
			speakers: Speaker[] = [],
			language: string | null = null,
			prevEnd = 0;
		const calls: Effect.Success<ReturnType<typeof parseHeard>>[] = [];
		for (const window of duration === 0 ? [] : windows(duration, chunk, overlap)) {
			const { from, to } = byteRange(window);
			const before = segments
				.filter((s) => s.end > window.start)
				.map((s) => `${s.speaker}: ${s.text}`)
				.join(' ')
				.slice(-1500);
			const heard = yield* hear(audio.subarray(from, to), instructions(options, { speakers, before }));
			calls.push(heard);
			language ??= heard.language;
			const absolute = placed(heard.segments, window).map((s) => ({
				...s,
				speaker: options.diarize === false ? 'S1' : s.speaker
			}));
			const merged = merge(segments, prevEnd, { start: window.start, segments: absolute }, speakers.map((s) => s.label));
			segments = merged.segments;
			for (const s of heard.speakers) {
				const label = merged.labels.get(s.label) ?? s.label;
				speakers = [...speakers.filter((v) => v.label !== label), { label, description: s.description }];
			}
			prevEnd = window.end;
		}
		return {
			transcript: {
				language,
				durationMs: Math.round(duration * 1000),
				speakers,
				// speech overlapping at a chunk's edge may start before the line kept from the chunk before it
				segments: segments.toSorted((a, b) => a.start - b.start)
			},
			usage: {
				calls: calls.flatMap((h) => (h.id === null ? [] : [h.id])),
				model: c.model,
				input: calls.reduce((n, h) => n + h.input, 0),
				output: calls.reduce((n, h) => n + h.output, 0),
				cost: calls.reduce((n, h) => n + h.cost, 0)
			}
		};
	});
}
