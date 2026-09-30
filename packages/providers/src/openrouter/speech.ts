// Bolt's SpeechPort over OpenRouter (`ctx.ai.transcribe`, `ctx.ai.speak`). Transcription is a chat completion on an
// audio-input model (Gemini) with a structured answer of diarized segments; speech is `/audio/speech`.
//
// Long audio: ffmpeg (the host's binary, streaming, never the decoded PCM in memory) re-encodes the file once to mono
// 16 kHz 32 kbps constant-bit-rate MP3 on disk. Every frame of that stream is 144 bytes and 36 ms, so a chunk is a byte
// range at a frame boundary: read one at a time, sent, dropped. Chunks overlap; each request carries the speakers heard
// so far (label + a short voice description) and the words said just before, the labels are reconciled by where the two
// chunks' segments overlap in time, and the overlap is cut at its midpoint. Without ffmpeg a file goes whole, in its own
// format.
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeechFormat, SpeechPort, TranscribeOptions, Transcript, TranscriptSegment } from '@norbital-ai/bolt/engine';
import { isObj } from '../util.ts';

export type OpenRouterSpeechConfig = {
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
	meter?: (costUsd: number, id: string) => unknown;
};

type Kind = 'upstream' | 'timeout' | 'rateLimited' | 'invalid' | 'tooLarge' | 'unsupported';
/** A throw bolt answers as the FacilityError of this kind. */
export class SpeechFailure extends Error {
	readonly kind: Kind;
	readonly status: number | undefined;
	constructor(kind: Kind, message: string, status?: number) { super(message); this.name = 'SpeechFailure'; this.kind = kind; this.status = status; }
}

/** Frames of the normalized stream (MPEG-2 layer III, 16 kHz, 32 kbps, no padding): 576 samples in 144 bytes. */
export const FRAME_BYTES = 144, FRAME_S = 0.036;
const MIME: { readonly [F in SpeechFormat]: string } = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };
/** OpenRouter's `input_audio.format` by MIME type; anything else needs ffmpeg. */
const FORMATS: { readonly [mime: string]: string } = {
	'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
	'audio/x-flac': 'flac', 'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
};
const SPEAK_BYTES = 4 * 1024 * 1024;
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
/** A window as a byte range of the normalized stream, on frame boundaries. */
export const byteRange = (w: { start: number; end: number }) =>
	({ from: Math.floor(w.start / FRAME_S) * FRAME_BYTES, to: Math.ceil(w.end / FRAME_S) * FRAME_BYTES });

type Speaker = { label: string; description: string };
type Heard = { language: string | null; speakers: Speaker[]; segments: TranscriptSegment[] };
const token = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const words = (s: string) => s.split(/\s+/).map(token).filter(Boolean).join(' ');
/** A second-by-second overlap tolerance, and how close to a window edge a segment is cut off by it. */
const EDGE = 0.5;

/**
 * One utterance heard by two chunks, `b` cut off by the first chunk's end and `n` starting with the second: `n` goes on
 * after the longest run of `b`'s last words it repeats; with none, after the share of its words the overlap `heard` holds.
 */
export function splice(b: string, n: string, heard: number): string {
	const bw = b.split(/\s+/).filter(Boolean).map(token), nt = n.split(/\s+/).filter(Boolean), nw = nt.map(token);
	for (let k = Math.min(bw.length, nw.length); k >= 2; k--) {
		const tail = bw.slice(-k).join(' ');
		for (let j = 0; j + k <= nw.length; j++) if (nw.slice(j, j + k).join(' ') === tail) return [b, ...nt.slice(j + k)].join(' ');
	}
	return [b, ...nt.slice(Math.round(nt.length * Math.min(1, Math.max(0, heard))))].join(' ');
}

/**
 * One chunk's segments (absolute seconds) joined onto what came before: the new chunk's labels are mapped to the ones
 * they overlap most in time (else kept when the model reused a known label, else numbered next). The overlap
 * `[next.start, prevEnd]` is cut at the segment boundary nearest its middle, each segment going to the side its middle
 * falls on; when one utterance runs through the whole overlap its two hearings are spliced into one segment.
 */
export function merge(before: readonly TranscriptSegment[], prevEnd: number, next: { start: number; segments: readonly TranscriptSegment[] }, known: readonly string[]):
	{ segments: TranscriptSegment[]; labels: Map<string, string> } {
	const lo = next.start, hi = prevEnd;
	const shared = (a: TranscriptSegment, b: TranscriptSegment) => Math.max(0, Math.min(a.end, b.end, hi) - Math.max(a.start, b.start, lo));
	const labels = new Map<string, string>(), rest: string[] = [];
	for (const label of [...new Set(next.segments.map((s) => s.speaker))]) {
		const votes = new Map<string, number>();
		for (const n of next.segments.filter((s) => s.speaker === label)) for (const p of before) votes.set(p.speaker, (votes.get(p.speaker) ?? 0) + shared(n, p));
		const [best, time] = [...votes].reduce((a, b) => b[1] > a[1] ? b : a, ['', 0]);
		if (time > 0) labels.set(label, best); else rest.push(label);
	}
	// unheard in the overlap: a known label keeps itself unless another took it (a swap: it takes a free known one); else new
	const claimed = new Set(labels.values());
	for (const label of rest.filter((l) => known.includes(l) && !claimed.has(l))) { labels.set(label, label); claimed.add(label); }
	for (const label of rest.filter((l) => !labels.has(l))) {
		let to = known.includes(label) ? known.find((k) => !claimed.has(k)) : undefined;
		for (let n = 1; to === undefined; n++) if (!claimed.has(`S${n}`) && !known.includes(`S${n}`)) to = `S${n}`;
		labels.set(label, to);
		claimed.add(to);
	}
	const relabel = (s: TranscriptSegment) => ({ ...s, speaker: labels.get(s.speaker)! });
	const mid = (s: TranscriptSegment) => (s.start + s.end) / 2, middle = (lo + hi) / 2;
	const b = before.at(-1), at = next.segments.findIndex((s) => s.end > lo + EDGE), n = next.segments[at];
	const bounds = [...before.map((s) => s.end), ...next.segments.map((s) => s.start)].filter((t) => t > lo + EDGE && t < hi - EDGE);
	if (bounds.length === 0 && b !== undefined && n !== undefined && b.end >= hi - EDGE && n.start <= lo + EDGE)
		return { labels, segments: [...before.slice(0, -1), { speaker: b.speaker, start: b.start, end: n.end, text: splice(b.text, n.text, (hi - n.start) / Math.max(EDGE, n.end - n.start)) },
			...next.segments.slice(at + 1).map(relabel)] };
	const cut = bounds.length === 0 ? middle : bounds.reduce((x, t) => Math.abs(t - middle) < Math.abs(x - middle) ? t : x);
	const kept = before.filter((s) => mid(s) < cut);
	const added = next.segments.filter((s) => mid(s) >= cut).map(relabel);
	const last = kept.at(-1), first = added[0];
	if (last !== undefined && first !== undefined && words(last.text) === words(first.text)) added.shift();
	return { segments: [...kept, ...added], labels };
}

const SCHEMA = {
	type: 'object', additionalProperties: false, required: ['language', 'speakers', 'segments'],
	properties: {
		language: { type: ['string', 'null'], description: 'BCP 47 tag of the main language spoken, null when there is no speech' },
		speakers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'description'],
			properties: { label: { type: 'string' }, description: { type: 'string', description: 'a few words on the voice and role, to recognise it later' } } } },
		segments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['speaker', 'start', 'end', 'text'],
			properties: { speaker: { type: 'string' }, start: { type: 'number', description: 'seconds from the start of this audio' }, end: { type: 'number' }, text: { type: 'string' } } } },
	},
};

/** The instructions for one chunk: what is known so far, so labels carry across chunks. */
export function instructions(o: TranscribeOptions, context: { offset: number; speakers: readonly Speaker[]; before: string }): string {
	const diarize = o.diarize !== false;
	return [
		'Transcribe this audio verbatim, in the language spoken. Answer JSON only, in the given schema.',
		'Split it into segments at each change of speaker or pause, with start and end in seconds from the start of this audio.',
		diarize ? 'Label each speaker S1, S2, … by voice, and describe each voice in a few words (pitch, accent, role) in `speakers`.'
			: 'Do not tell speakers apart: label every segment S1.',
		...(diarize && o.speakers !== undefined ? [`There are ${o.speakers} speakers.`] : []),
		...(o.language === undefined ? [] : [`The expected language is ${o.language}.`]),
		...(o.prompt === undefined ? [] : [`Context: ${o.prompt}`]),
		...(diarize && context.speakers.length > 0 ? [`This audio continues a recording at ${context.offset.toFixed(1)} s. Speakers heard so far — reuse a label when the voice matches, use a new label for a new voice:`,
			...context.speakers.map((s) => `- ${s.label}: ${s.description}`)] : []),
		...(context.before === '' ? [] : [`Its first seconds were already heard as (transcribe this audio in full all the same): ${context.before}`]),
	].join('\n');
}

/** A chat answer's structured transcript, or a SpeechFailure naming what is wrong. */
export function parseHeard(body: unknown): Heard & { cost: number; id: string | null } {
	const choice = isObj(body) && Array.isArray(body['choices']) ? body['choices'][0] : undefined;
	const content = isObj(choice) && isObj(choice['message']) ? choice['message']['content'] : undefined;
	if (typeof content !== 'string') throw new SpeechFailure('upstream', 'the transcription model answered no text');
	let x: unknown;
	try {
		x = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
	} catch {
		throw new SpeechFailure('upstream', `the transcription model answered something that is not JSON: ${content.slice(0, 200)}`);
	}
	const segs = isObj(x) && Array.isArray(x['segments']) ? x['segments'] : null;
	if (!isObj(x) || segs === null || !segs.every((s) => isObj(s) && typeof s['speaker'] === 'string' && typeof s['text'] === 'string'
		&& typeof s['start'] === 'number' && typeof s['end'] === 'number' && Number.isFinite(s['start']) && Number.isFinite(s['end'])))
		throw new SpeechFailure('upstream', 'the transcription model answered segments out of the schema');
	const usage = isObj(body) && isObj(body['usage']) ? body['usage'] : {};
	return {
		language: typeof x['language'] === 'string' && x['language'] !== '' ? x['language'] : null,
		speakers: (Array.isArray(x['speakers']) ? x['speakers'] : []).flatMap((s) => isObj(s) && typeof s['label'] === 'string'
			? [{ label: s['label'], description: typeof s['description'] === 'string' ? s['description'] : '' }] : []),
		segments: (segs as { speaker: string; start: number; end: number; text: string }[]).map(({ speaker, start, end, text }) => ({ speaker, start, end, text })),
		cost: Number(usage['cost'] ?? 0) || 0, id: isObj(body) && typeof body['id'] === 'string' ? body['id'] : null,
	};
}

/** ffmpeg under `signal`: resolves with stdout (at most 4 MiB), rejects with its stderr's tail; `null` when the binary is absent. */
function ffmpeg(bin: string, args: readonly string[], signal: AbortSignal, input?: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
	return new Promise((resolve, reject) => {
		const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { signal, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
		const out: Buffer[] = [];
		let err = '', size = 0;
		p.stdout!.on('data', (b: Buffer) => { size += b.length; if (size <= SPEAK_BYTES) out.push(b); });
		p.stderr!.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-2000); });
		p.on('error', (e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? resolve(null) : reject(e));
		p.on('close', (code) => code === 0 ? size > SPEAK_BYTES ? reject(new SpeechFailure('tooLarge', 'the audio is larger than 4 MiB; say less at a time')) : resolve(Buffer.concat(out))
			: reject(new SpeechFailure('invalid', `ffmpeg could not read the audio: ${err.trim() || `exit ${code}`}`)));
		if (input !== undefined) {
			p.stdin!.on('error', () => {}); // ffmpeg gone: its exit answers
			Readable.fromWeb(input as import('node:stream/web').ReadableStream<Uint8Array>).on('error', () => p.kill()).pipe(p.stdin!);
		}
	});
}

/** 16-bit little-endian PCM as a WAV file. */
export function wav(pcm: Uint8Array, rate: number, channels: number): Uint8Array {
	const out = new Uint8Array(44 + pcm.byteLength), v = new DataView(out.buffer);
	const ascii = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
	ascii(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
	v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
	v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
	ascii(36, 'data'); v.setUint32(40, pcm.byteLength, true);
	out.set(pcm, 44);
	return out;
}

export function openRouterSpeech(c: OpenRouterSpeechConfig, transport: typeof fetch = fetch): SpeechPort {
	const base = (c.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
	const bin = c.ffmpeg === false ? null : c.ffmpeg ?? 'ffmpeg';
	const chunk = c.chunkSeconds ?? 300, overlap = c.overlapSeconds ?? 15;
	const post = async (path: string, body: unknown, signal: AbortSignal): Promise<Response> => {
		const r = await transport(`${base}${path}`, { method: 'POST', signal, body: JSON.stringify(body),
			headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' } });
		if (r.ok) return r;
		const text = (await r.text().catch(() => '')).slice(0, 500);
		throw new SpeechFailure(r.status === 429 ? 'rateLimited' : r.status === 413 ? 'tooLarge' : r.status >= 400 && r.status < 500 ? 'invalid' : 'upstream',
			`OpenRouter refused the request (HTTP ${r.status}): ${text}`, r.status);
	};
	/** One chunk heard, retried twice on a rate limit, a 5xx or an answer out of the schema. */
	const hear = async (model: string, audio: Uint8Array, format: string, prompt: string, signal: AbortSignal): Promise<Heard> => {
		for (let attempt = 0; ; attempt++) {
			try {
				const body = await (await post('/chat/completions', {
					// low effort: a transcript needs little thought, and default reasoning tripled the cost of each minute
					model, temperature: 0, usage: { include: true }, reasoning: { effort: 'low' },
					response_format: { type: 'json_schema', json_schema: { name: 'transcript', strict: true, schema: SCHEMA } },
					messages: [{ role: 'system', content: prompt }, { role: 'user', content: [{ type: 'input_audio', input_audio: { data: Buffer.from(audio).toString('base64'), format } }] }],
				}, signal)).json();
				const heard = parseHeard(body);
				if (heard.cost > 0) await Promise.resolve(c.meter?.(heard.cost, heard.id ?? `transcribe:${crypto.randomUUID()}`)).catch(() => {});
				return heard;
			} catch (e) {
				const retry = e instanceof SpeechFailure && (e.kind === 'rateLimited' || e.kind === 'upstream');
				if (!retry || attempt >= 2 || signal.aborted) throw e;
				await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
			}
		}
	};

	const transcribe = c.transcribeModel === undefined ? undefined : async (audio: { name: string; mime: string; bytes: Uint8Array }, o: TranscribeOptions, signal: AbortSignal): Promise<Transcript> => {
		const model = c.transcribeModel!;
		const dir = bin === null ? null : await mkdtemp(join(tmpdir(), 'bolt-speech-'));
		try {
			const normalized = dir === null ? null : await (async () => {
				await writeFile(join(dir, 'in'), audio.bytes);
				const done = await ffmpeg(bin!, ['-i', join(dir, 'in'), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
					'-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3', join(dir, 'audio.mp3')], signal);
				return done === null ? null : join(dir, 'audio.mp3');
			})();
			if (normalized === null) {
				const format = FORMATS[audio.mime.split(';')[0]!.trim().toLowerCase()];
				if (format === undefined) throw new SpeechFailure('unsupported', `this host cannot read ${audio.mime} audio (it has no ffmpeg)`);
				const heard = await hear(model, audio.bytes, format, instructions(o, { offset: 0, speakers: [], before: '' }), signal);
				const segments = heard.segments.map((s) => ({ ...s, speaker: o.diarize === false ? 'S1' : s.speaker }));
				return { segments, language: heard.language, durationMs: Math.round(Math.max(0, ...segments.map((s) => s.end)) * 1000) };
			}
			const duration = (await stat(normalized)).size / (FRAME_BYTES / FRAME_S);
			if (duration === 0) return { segments: [], language: null, durationMs: 0 };
			const file = await open(normalized);
			let segments: TranscriptSegment[] = [], speakers: Speaker[] = [], language: string | null = null, prevEnd = 0;
			try {
				for (const w of windows(duration, chunk, overlap)) {
					const { from, to } = byteRange(w);
					const bytes = new Uint8Array(to - from);
					const { bytesRead } = await file.read(bytes, 0, bytes.length, from);
					const before = segments.filter((s) => s.end > w.start).map((s) => `${s.speaker}: ${s.text}`).join(' ').slice(-1500);
					const heard = await hear(model, bytes.subarray(0, bytesRead), 'mp3', instructions(o, { offset: w.start, speakers, before }), signal);
					language ??= heard.language;
					const absolute = heard.segments.map((s) => ({ ...s, speaker: o.diarize === false ? 'S1' : s.speaker,
						start: ms(Math.min(w.end, w.start + Math.max(0, s.start))), end: ms(Math.min(w.end, w.start + Math.max(0, s.end))) }));
					const m = merge(segments, prevEnd, { start: w.start, segments: absolute }, speakers.map((s) => s.label));
					segments = m.segments;
					for (const s of heard.speakers) {
						const label = m.labels.get(s.label) ?? s.label;
						speakers = [...speakers.filter((x) => x.label !== label), { label, description: s.description }];
					}
					prevEnd = w.end;
				}
			} finally {
				await file.close();
			}
			return { segments, language, durationMs: Math.round(duration * 1000) };
		} finally {
			if (dir !== null) await rm(dir, { recursive: true, force: true });
		}
	};

	// ponytail: `/audio/speech` answers no cost, so speech is not metered; read `/generation?id=` when it must be billed.
	// PCM is the one format every speech model answers (its rate and channels in the content type): wav wraps it here,
	// mp3 and ogg stream it through ffmpeg.
	const speak = c.speakModel === undefined ? undefined : async (text: string, o: { voice?: string; format: SpeechFormat; language?: string }, signal: AbortSignal) => {
		const voice = o.voice ?? c.speakVoice;
		if (o.format !== 'wav' && bin === null) throw new SpeechFailure('unsupported', `this host writes speech as wav only (it has no ffmpeg for ${o.format})`);
		const r = await post('/audio/speech', { model: c.speakModel, input: text, response_format: 'pcm', ...(voice === undefined ? {} : { voice }) }, signal);
		const type = r.headers.get('content-type') ?? '';
		const rate = String(Number(/rate=(\d+)/.exec(type)?.[1] ?? 24_000)), channels = String(Number(/channels=(\d+)/.exec(type)?.[1] ?? 1));
		if (r.body === null) throw new SpeechFailure('upstream', 'OpenRouter answered no audio');
		if (o.format === 'wav') {
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (const reader = r.body.getReader(); ;) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.byteLength;
				if (size > SPEAK_BYTES - 44) { await reader.cancel(); throw new SpeechFailure('tooLarge', 'the speech is larger than 4 MiB as wav; say less at a time, or ask for mp3'); }
				chunks.push(part.value);
			}
			return { bytes: wav(Buffer.concat(chunks), Number(rate), Number(channels)), mime: MIME.wav };
		}
		const out = await ffmpeg(bin!, ['-f', 's16le', '-ar', rate, '-ac', channels, '-i', 'pipe:0',
			...(o.format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3'] : ['-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg']), 'pipe:1'], signal, r.body);
		if (out === null) throw new SpeechFailure('unsupported', `this host writes speech as wav only (it has no ffmpeg for ${o.format})`);
		return { bytes: out, mime: MIME[o.format] };
	};

	return { ...(transcribe === undefined ? {} : { transcribe }), ...(speak === undefined ? {} : { speak }) };
}
