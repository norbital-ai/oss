// Audio: chunk windows, chunk times placed on the recording's clock, overlaps merged, the whole path over a fake model
// endpoint (no network), and the HTTP answers for an unconfigured converter and a file with a video track.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, test } from '@effect/vitest';
import { Effect } from 'effect';
import { type Converter } from '../src/convert.ts';
import { ingester } from '../src/ingest.ts';
import { service } from '../src/server.ts';
import { merge, placed, transcriber, windows, type Segment } from '../src/transcribe.ts';

const dir = mkdtempSync(join(tmpdir(), 'convert-audio-'));
/** A test recording written by ffmpeg: `seconds` of tone, with a test-pattern video track when `video`. */
const media = (name: string, seconds: number, video = false) => {
	const out = join(dir, name);
	execFileSync('ffmpeg', [
		'-hide_banner', '-loglevel', 'error', '-y',
		'-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
		...(video ? ['-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=64x64:rate=5`, '-c:v', 'mpeg4'] : []),
		'-c:a', 'aac', '-shortest', out
	]);
	return readFileSync(out);
};
const seg = (speaker: string, start: number, end: number, text: string): Segment => ({ speaker, start, end, text });

test('chunk windows overlap by the overlap and end at the duration', () => {
	assert.deepEqual(windows(700, 300, 15), [
		{ start: 0, end: 300 },
		{ start: 285, end: 585 },
		{ start: 570, end: 700 }
	]);
	assert.deepEqual(windows(120, 300, 15), [{ start: 0, end: 120 }]);
});

test('chunk times are shifted to the recording clock, unless the model already answered absolute times', () => {
	const window = { start: 285, end: 585 };
	assert.deepEqual(placed([seg('S1', 0, 10, 'a'), seg('S2', 290, 300, 'b')], window), [
		seg('S1', 285, 295, 'a'),
		seg('S2', 575, 585, 'b')
	]);
	assert.deepEqual(placed([seg('S1', 286, 300, 'a'), seg('S2', 310, 330, 'b')], window), [
		seg('S1', 286, 300, 'a'),
		seg('S2', 310, 330, 'b')
	]);
});

test('an overlap is cut once: labels follow the voice heard in it, a repeated line goes', () => {
	const before = [seg('S1', 270, 280, 'we start on monday'), seg('S2', 281, 296, 'agreed the crane comes first')];
	const next = { start: 285, segments: [seg('S1', 286, 296, 'agreed the crane comes first'), seg('S2', 297, 310, 'and the scaffold after')] };
	const out = merge(before, 300, next, ['S1', 'S2']);
	assert.deepEqual(out.labels, new Map([['S1', 'S2'], ['S2', 'S1']]));
	assert.deepEqual(out.segments.map((s) => `${s.speaker} ${s.text}`), [
		'S1 we start on monday',
		'S2 agreed the crane comes first',
		'S1 and the scaffold after'
	]);
});

test('a recording is heard chunk by chunk over the fake model, merged, sorted, its usage summed', async () => {
	const calls: string[] = [];
	const answers = [
		// chunk 1 (0-20 s): relative times
		{ speakers: [{ label: 'S1', description: 'low voice' }], segments: [seg('S1', 1, 8, 'first line'), seg('S1', 9, 19.5, 'second line runs on')] },
		// chunk 2 (15-35 s): absolute times, and a segment out of order
		{ speakers: [{ label: 'S1', description: 'low voice' }], segments: [seg('S1', 26, 30, 'fourth line'), seg('S1', 20, 25, 'third line')] }
	];
	const fake: typeof fetch = async (_url, init) => {
		calls.push(String(init?.body ?? ''));
		const answer = answers[calls.length - 1]!;
		return Response.json({
			id: `gen-${calls.length}`,
			choices: [{ message: { content: JSON.stringify({ language: 'en', ...answer }) } }],
			usage: { cost: 0.001, prompt_tokens: 1000, completion_tokens: 100 }
		});
	};
	const transcribe = transcriber({ baseUrl: 'http://model.test/v1', apiKey: 'k', model: 'm', chunkSeconds: 20, overlapSeconds: 5, fetch: fake });
	const ingest = ingester({ lanes: 1, transcribe });
	const out = await Effect.runPromise(ingest({ name: 'site.m4a', mime: 'audio/mp4', bytes: media('tone.m4a', 30) }));
	if (out.kind !== 'document') throw new Error('a transcript is a document');
	assert.equal(calls.length, 2);
	assert.match(calls[1]!, /Speakers heard so far/);
	// The transcript rides in the HTML, one section per segment; the model's usage is the job's meta, not the parse.
	assert.deepEqual(out.html.split('\n'), [
		'<section data-speaker="S1" data-start="1" data-end="8"><time>00:00:01</time> first line</section>',
		'<section data-speaker="S1" data-start="9" data-end="19.5"><time>00:00:09</time> second line runs on</section>',
		'<section data-speaker="S1" data-start="20" data-end="25"><time>00:00:20</time> third line</section>',
		'<section data-speaker="S1" data-start="26" data-end="30"><time>00:00:26</time> fourth line</section>'
	]);
	assert.deepEqual(out.images, []);
	assert.deepEqual(out.meta.usage, { calls: ['gen-1', 'gen-2'], model: 'm', input: 2000, output: 200, cost: 0.002 });
	assert.equal(out.meta.stats.pages, null);
});

const running: { stop: () => Promise<void> }[] = [];
afterAll(() => Promise.all(running.map((s) => s.stop())));
const never: Converter = () => Effect.die('not a conversion');
async function start(transcribes: boolean) {
	const ingest = ingester({
		lanes: 1,
		transcribe: () =>
			Effect.succeed({
				transcript: { language: 'en', durationMs: 2000, speakers: [], segments: [seg('S1', 0, 2, 'hello')] },
				usage: { calls: [], model: 'm', input: 0, output: 0, cost: 0 }
			})
	});
	const svc = service({ keys: ['k1'], database: join(dir, `db-${running.length}.db`), pollMs: 20, convert: never, ingest, transcribes });
	running.push(svc);
	await new Promise<void>((r) => svc.server.listen(0, r));
	const address = svc.server.address();
	if (address === null || typeof address === 'string') throw new Error('no TCP address');
	return (name: string, mime: string, bytes: Uint8Array) =>
		fetch(`http://localhost:${address.port}/v1/ingest`, {
			method: 'POST',
			headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
			body: JSON.stringify({ name, mime, bytes: Buffer.from(bytes).toString('base64'), options: { diarize: true } })
		});
}

test('audio without a transcription model is 503; a video track is 415; audio-only mp4 is transcribed', async () => {
	const off = await start(false);
	const unavailable = await off('call.mp3', 'audio/mpeg', new Uint8Array([1]));
	assert.equal(unavailable.status, 503);
	assert.deepEqual(await unavailable.json(), { error: 'unavailable', message: 'this converter has no transcription model' });

	const on = await start(true);
	const video = await on('clip.mp4', 'video/mp4', media('clip.mp4', 1, true));
	assert.equal(video.status, 415);
	assert.deepEqual(await video.json(), { error: 'unsupported', message: 'no parser: build a tool for it with your workspace tools' });
	const audio = await on('call.mp4', 'video/mp4', media('call.mp4', 1));
	assert.equal(audio.status, 200);
	assert.match(await audio.text(), /"kind":"document","html":"<section data-speaker=\\"S1\\" data-start=\\"0\\" data-end=\\"2\\"><time>00:00:00<\/time> hello<\/section>","images":\[\],"meta":\{"usage":/);
});
