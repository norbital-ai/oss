// OpenRouter speech behind bolt's SpeechPort: the request shapes against a fake fetch (never the real API), the chunk
// arithmetic, speaker reconciliation and overlap de-duplication; the chunked path runs the host's ffmpeg when it has one.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { byteRange, FRAME_BYTES, merge, openRouterSpeech, parseHeard, SpeechFailure, splice, wav, windows } from '../src/openrouter/speech.ts';
import { fakeFetch, json, signal, type Call } from './kit.ts';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const tone = (seconds: number) => new Uint8Array(execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-f', 'mp3', 'pipe:1']));
const answer = (content: unknown, extra: object = {}) => json({ id: 'gen-1', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { cost: 0.002 }, ...extra });
const seg = (speaker: string, start: number, end: number, text: string) => ({ speaker, start, end, text });
const sent = (c: Call) => JSON.parse(c.body) as { model: string; messages: [{ content: string }, { content: [{ type: string; input_audio: { data: string; format: string } }] }]; response_format: { type: string; json_schema: { strict: boolean } } };

describe('chunk arithmetic', () => {
	it('overlaps windows by the overlap and ends at the duration', () => {
		expect(windows(700, 300, 15)).toEqual([{ start: 0, end: 300 }, { start: 285, end: 585 }, { start: 570, end: 700 }]);
		expect(windows(100, 300, 15)).toEqual([{ start: 0, end: 100 }]);
		expect(() => windows(10, 5, 5)).toThrow();
	});
	it('maps a window to whole 144-byte frames of 36 ms', () => {
		const r = byteRange({ start: 285, end: 585 });
		expect(r.from % FRAME_BYTES).toBe(0);
		expect(r.to % FRAME_BYTES).toBe(0);
		expect(r.from).toBe(Math.floor(285 / 0.036) * 144);
		expect((r.to - r.from) / 4000).toBeGreaterThanOrEqual(300);
	});
});

describe('merge', () => {
	const before = [seg('S1', 0, 10, 'Good morning.'), seg('S2', 10, 18, 'Morning, shall we start?'), seg('S1', 18, 29, 'Yes, the first item.')];
	it('maps the next chunk\'s labels by time shared in the overlap and cuts it at the boundary nearest its middle', () => {
		// overlap [16, 30], cut at 18 (nearest 23 of the boundaries 18 and 29): the model swapped the labels in the second chunk
		const next = { start: 16, segments: [seg('S1', 16, 18, 'shall we start?'), seg('S2', 18, 29, 'Yes, the first item.'), seg('S2', 29, 35, 'Budgets.'), seg('S3', 35, 40, 'Sorry I am late.')] };
		const m = merge(before, 30, next, ['S1', 'S2']);
		expect(m.labels).toEqual(new Map([['S1', 'S2'], ['S2', 'S1'], ['S3', 'S3']]));
		expect(m.segments).toEqual([...before, seg('S1', 29, 35, 'Budgets.'), seg('S3', 35, 40, 'Sorry I am late.')]);
	});
	it('drops a segment repeated across the seam and numbers a new voice after the known ones', () => {
		const next = { start: 16, segments: [seg('A', 23, 29, 'yes the first item'), seg('B', 31, 33, 'Hello?')] };
		const m = merge([seg('S1', 0, 10, 'Good morning.'), seg('S3', 22, 29, 'Yes, the first item.')], 30, next, ['S1', 'S3']);
		expect(m.labels.get('B')).toBe('S2');
		expect(m.segments.map((s) => s.text)).toEqual(['Good morning.', 'yes the first item', 'Hello?']);
	});
	it('splices one utterance that runs through the whole overlap from its two hearings', () => {
		const m = merge([seg('S1', 18, 22, 'Understood.'), seg('S1', 29.8, 35, 'Great. Second item, the new invoice template. Finance wants it live by the first')], 35,
			{ start: 30, segments: [seg('S1', 30, 36.2, 'item, the new invoice template. Finance wants it live by the first of next month.')] }, ['S1', 'S2']);
		expect(m.segments).toEqual([seg('S1', 18, 22, 'Understood.'), seg('S1', 29.8, 36.2, 'Great. Second item, the new invoice template. Finance wants it live by the first of next month.')]);
	});
	it('splices by the repeated words, else by the share of time the overlap held', () => {
		expect(splice('we lost about forty drops', 'About forty drops, so', 0.5)).toBe('we lost about forty drops so');
		expect(splice('one two three', 'four five six seven', 0.5)).toBe('one two three six seven');
	});
	it('takes the first chunk whole', () => {
		expect(merge([], 0, { start: 0, segments: [seg('S2', 0, 1, 'a'), seg('S1', 1, 2, 'b')] }, []).segments.map((s) => s.speaker)).toEqual(['S1', 'S2']);
	});
});

describe('parseHeard', () => {
	it('reads the structured answer, fenced or not', () => {
		const h = parseHeard({ id: 'g', choices: [{ message: { content: '```json\n{"language":"en","speakers":[{"label":"S1","description":"low"}],"segments":[{"speaker":"S1","start":0,"end":1,"text":"Hi"}]}\n```' } }], usage: { cost: 0.01 } });
		expect(h).toEqual({ language: 'en', speakers: [{ label: 'S1', description: 'low' }], segments: [seg('S1', 0, 1, 'Hi')], cost: 0.01, id: 'g' });
	});
	it('refuses prose, no text and segments out of the schema as SpeechFailure', () => {
		for (const body of [{ choices: [{ message: { content: 'Sure! Here is the transcript' } }] }, { choices: [] },
			{ choices: [{ message: { content: '{"segments":[{"speaker":"S1","start":"0","end":1,"text":"x"}]}' } }] }])
			expect(() => parseHeard(body)).toThrow(SpeechFailure);
	});
});

describe('openRouterSpeech', () => {
	it('binds only the capabilities whose model is configured', () => {
		expect(Object.keys(openRouterSpeech({ apiKey: 'k' }))).toEqual([]);
		expect(Object.keys(openRouterSpeech({ apiKey: 'k', transcribeModel: 'google/gemini-3.5-flash', speakModel: 'google/gemini-3.8-flash-tts' }))).toEqual(['transcribe', 'speak']);
	});

	it('sends a short file whole as input_audio with a strict JSON schema, and meters its cost', async () => {
		const metered: [number, string][] = [];
		const f = fakeFetch([() => answer({ language: 'en', speakers: [], segments: [seg('S1', 0, 1.5, 'Hello.'), seg('S2', 1.5, 2, 'Hi.')] })]);
		const port = openRouterSpeech({ apiKey: 'key', baseUrl: 'https://or.test/api/v1/', transcribeModel: 'google/gemini-3.5-flash', ffmpeg: false, meter: (c, id) => metered.push([c, id]) }, f);
		const audio = new Uint8Array([0xff, 0xf3, 9, 9]);
		const t = await port.transcribe!({ name: 'a.mp3', mime: 'audio/mpeg', bytes: audio }, { speakers: 2, language: 'en', prompt: 'A standup' }, signal());
		expect(t).toEqual({ segments: [seg('S1', 0, 1.5, 'Hello.'), seg('S2', 1.5, 2, 'Hi.')], language: 'en', durationMs: 2000 });
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]!.url).toBe('https://or.test/api/v1/chat/completions');
		expect(f.calls[0]!.headers['authorization']).toBe('Bearer key');
		const body = sent(f.calls[0]!);
		expect(body.model).toBe('google/gemini-3.5-flash');
		expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
		expect(body.messages[0].content).toContain('There are 2 speakers.');
		expect(body.messages[0].content).toContain('Context: A standup');
		expect(body.messages[1].content[0]).toEqual({ type: 'input_audio', input_audio: { data: Buffer.from(audio).toString('base64'), format: 'mp3' } });
		expect(metered).toEqual([[0.002, 'gen-1']]);
	});

	it('labels everything S1 when not diarizing, and refuses a format it cannot send without ffmpeg', async () => {
		const f = fakeFetch([() => answer({ language: null, speakers: [], segments: [seg('S1', 0, 1, 'a'), seg('S2', 1, 2, 'b')] })]);
		const port = openRouterSpeech({ apiKey: 'k', transcribeModel: 'm', ffmpeg: false }, f);
		expect((await port.transcribe!({ name: 'a.wav', mime: 'audio/wav', bytes: new Uint8Array(4) }, { diarize: false }, signal())).segments.map((s) => s.speaker)).toEqual(['S1', 'S1']);
		expect(sent(f.calls[0]!).messages[0].content).toContain('label every segment S1');
		await expect(port.transcribe!({ name: 'a.webm', mime: 'audio/webm', bytes: new Uint8Array(4) }, {}, signal())).rejects.toMatchObject({ kind: 'unsupported' });
	});

	it('retries a rate limit, then passes a refusal through as its kind', async () => {
		let n = 0;
		const f = fakeFetch([() => ++n === 1 ? json({ error: 'slow' }, 429) : answer({ language: 'en', speakers: [], segments: [] })]);
		const port = openRouterSpeech({ apiKey: 'k', transcribeModel: 'm', ffmpeg: false }, f);
		expect((await port.transcribe!({ name: 'a.mp3', mime: 'audio/mpeg', bytes: new Uint8Array(4) }, {}, signal())).segments).toEqual([]);
		expect(f.calls).toHaveLength(2);
		const refused = openRouterSpeech({ apiKey: 'k', transcribeModel: 'm', ffmpeg: false }, fakeFetch([() => json({ error: 'no audio' }, 400)]));
		await expect(refused.transcribe!({ name: 'a.mp3', mime: 'audio/mpeg', bytes: new Uint8Array(4) }, {}, signal())).rejects.toMatchObject({ kind: 'invalid', status: 400 });
	});

	it.skipIf(!hasFfmpeg)('splits long audio into overlapping frame-aligned mp3 chunks, carrying the speakers across', async () => {
		const prompts: string[] = [];
		const chunks: Uint8Array[] = [];
		// each chunk re-hears the previous one's last 4 s, then new speech; the second chunk swaps the labels, as a model may
		const script = [[seg('S1', 0, 9, 'c0 a'), seg('S2', 9, 20, 'we lost about forty drops')], [seg('S1', 0, 4, 'about forty drops'), seg('S2', 4, 20, 'borrow a van until Friday')],
			[seg('S1', 0, 4, 'until Friday'), seg('S2', 4, 18, 'c2')]];
		const f = fakeFetch([(c) => {
			const b = sent(c);
			prompts.push(b.messages[0].content);
			chunks.push(Buffer.from(b.messages[1].content[0].input_audio.data, 'base64'));
			const segments = script[chunks.length - 1]!;
			return answer({ language: 'en', speakers: [...new Set(segments.map((s) => s.speaker))].map((l) => ({ label: l, description: `voice ${l}` })), segments });
		}]);
		const port = openRouterSpeech({ apiKey: 'k', transcribeModel: 'm', chunkSeconds: 20, overlapSeconds: 4 }, f);
		const t = await port.transcribe!({ name: 'a.mp3', mime: 'audio/mpeg', bytes: tone(50) }, {}, AbortSignal.timeout(30_000));
		expect(chunks).toHaveLength(3); // [0, 20], [16, 36], [32, ~50]
		for (const c of chunks) expect([c[0], c[1]! & 0xfe]).toEqual([0xff, 0xf2]); // each starts on an MPEG-2 layer III frame
		expect(chunks[0]!.byteLength).toBeGreaterThanOrEqual(20 * 4000);
		expect(prompts[1]).toContain('continues a recording at 16.0 s');
		expect(prompts[1]).toContain('- S2: voice S2');
		expect(prompts[1]).toContain('S2: we lost about forty drops');
		expect(Math.abs(t.durationMs - 50_000)).toBeLessThan(200);
		expect(t.segments).toEqual([seg('S1', 0, 9, 'c0 a'), seg('S2', 9, 20, 'we lost about forty drops'), seg('S1', 20, 36, 'borrow a van until Friday'), seg('S2', 36, 50, 'c2')]);
	}, 30_000);

	it('speaks through /audio/speech as PCM with the configured voice, wraps it as wav at its rate, and caps the audio', async () => {
		const pcm = new Uint8Array([1, 0, 2, 0, 3, 0]);
		const f = fakeFetch([() => new Response(pcm, { headers: { 'content-type': 'audio/pcm;rate=16000;channels=1' } })]);
		const port = openRouterSpeech({ apiKey: 'k', speakModel: 'google/gemini-3.8-flash-tts', speakVoice: 'Kore', ffmpeg: false }, f);
		expect(await port.speak!('Hello', { format: 'wav' }, signal())).toEqual({ bytes: wav(pcm, 16000, 1), mime: 'audio/wav' });
		expect(f.calls[0]!.url).toBe('https://openrouter.ai/api/v1/audio/speech');
		expect(JSON.parse(f.calls[0]!.body)).toEqual({ model: 'google/gemini-3.8-flash-tts', input: 'Hello', response_format: 'pcm', voice: 'Kore' });
		const header = new DataView(wav(pcm, 16000, 1).buffer);
		expect([header.getUint32(24, true), header.getUint32(40, true)]).toEqual([16000, 6]);
		await expect(port.speak!('Hello', { format: 'mp3' }, signal())).rejects.toMatchObject({ kind: 'unsupported' });
		expect(f.calls).toHaveLength(1); // refused before paying for audio it cannot write
		const big = openRouterSpeech({ apiKey: 'k', speakModel: 'm' }, fakeFetch([() => new Response(new Uint8Array(4 * 1024 * 1024))]));
		await expect(big.speak!('Hello', { format: 'wav', voice: 'x' }, signal())).rejects.toMatchObject({ kind: 'tooLarge' });
	});

	it.skipIf(!hasFfmpeg)('streams speech through ffmpeg to mp3 or ogg', async () => {
		const pcm = new Uint8Array(execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 's16le', '-ar', '24000', '-ac', '1', 'pipe:1']));
		const port = openRouterSpeech({ apiKey: 'k', speakModel: 'm' }, fakeFetch([() => new Response(pcm, { headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' } })]));
		const mp3 = await port.speak!('Hello', { format: 'mp3' }, AbortSignal.timeout(10_000));
		expect(mp3.mime).toBe('audio/mpeg');
		expect(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate', '-of', 'csv=p=0', '-'], { input: mp3.bytes }).toString().trim()).toBe('mp3,24000');
		const ogg = await port.speak!('Hello', { format: 'ogg' }, AbortSignal.timeout(10_000));
		expect([ogg.mime, new TextDecoder().decode(ogg.bytes.slice(0, 4))]).toEqual(['audio/ogg', 'OggS']);
	}, 20_000);
});
