// `documentIngester`: the agent's ingest port over Norbital Convert's `/v1/ingest`, against a fake service speaking its
// wire (SSE job events, then the result: a document or data; a resumed stream; audio's usage; a 415 for a format with no
// parser; a 503 when it has no transcription model).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll } from 'vitest';
import { describe, expect, it } from '@effect/vitest';
import { documentIngester } from '../src/engine/convert.ts';

const result = {
	kind: 'document',
	html: '<section data-page="1">\n<h1>Cover</h1>\n<img src="image-1.png" alt="">\n</section>',
	images: [
		{ name: 'image-1.png', mime: 'image/png', bytes: Buffer.from([0x89, 0x50]).toString('base64') }
	],
	meta: { stats: { pages: 1, bytes: 9, cpuMs: 3, wallMs: 5 } }
};
const audio = {
	kind: 'document',
	html: '<section data-speaker="S1" data-start="1" data-end="3"><time>00:00:01</time> Pour on Friday?</section>',
	images: [],
	meta: {
		usage: { calls: ['gen-1', 'gen-2'], model: 'gemini-x', input: 900, output: 40, cost: 0.002 },
		stats: { pages: null, bytes: 3, cpuMs: 0, wallMs: 900 }
	}
};
const sheet = {
	kind: 'data',
	json: {
		sheets: [
			{
				name: 'Rates',
				columns: ['Item', 'Rate'],
				rows: [['Labour', 42.5]],
				images: [{ name: 'image-1.png', row: 0, col: 1 }]
			}
		]
	},
	images: [{ name: 'image-1.png', mime: 'image/png', bytes: 'iVA=' }],
	meta: { stats: { pages: null, bytes: 7, cpuMs: 1, wallMs: 2 } }
};
const seen: { path: string; auth: string | undefined; body: unknown }[] = [];
const sse = (res: ServerResponse, events: readonly [string, unknown][], end = true) => {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const [event, data] of events)
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	if (end) res.end();
};
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	let raw = '';
	req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
	req.on('end', () => {
		const body: unknown = raw === '' ? null : JSON.parse(raw);
		seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
		const name =
			typeof body === 'object' && body !== null && 'name' in body ? String(body.name) : '';
		if (req.url === '/v1/ingest' && name === 'plan.dwg') {
			res.writeHead(415, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'unsupported', message: 'no parser for CAD drawings' }));
		} else if (req.url === '/v1/ingest' && name === 'mute.m4a') {
			res.writeHead(503, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					error: 'unavailable',
					message: 'this converter has no transcription model'
				})
			);
		} else if (req.url === '/v1/ingest' && name === 'rates.xlsx')
			sse(res, [
				['job', { id: 'j3', state: 'succeeded', error: null }],
				['result', sheet]
			]);
		else if (req.url === '/v1/ingest' && name === 'meeting.m4a')
			sse(res, [
				['job', { id: 'j2', state: 'succeeded', error: null }],
				['result', audio]
			]);
		else if (req.url === '/v1/ingest' && name === 'cut.pdf')
			// the stream ends after the job's first event: the client resumes it by the job id
			sse(res, [['job', { id: 'j9', state: 'running', error: null }]]);
		else if (req.url === '/v1/jobs/j9/events?result')
			sse(res, [
				['job', { id: 'j9', state: 'succeeded', error: null }],
				['result', result]
			]);
		else
			sse(res, [
				['job', { id: 'j1', state: 'succeeded', error: null }],
				['result', result]
			]);
	});
});
let url = '';
beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('no server address');
	url = `http://localhost:${address.port}/`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('documentIngester', () => {
	const file = (name: string) => ({
		sha256: 'abc',
		name,
		mime: 'application/pdf',
		bytes: new Uint8Array([1, 2, 3])
	});
	it('posts the file as base64 and decodes the result, images to bytes', async () => {
		const got = await documentIngester({ url, key: 'k' }).ingest(
			file('tender.pdf'),
			{},
			new AbortController().signal
		);
		expect(got).toEqual({
			...result,
			images: [{ name: 'image-1.png', mime: 'image/png', bytes: new Uint8Array([0x89, 0x50]) }]
		});
		expect(seen.at(-1)).toEqual({
			path: '/v1/ingest',
			auth: 'Bearer k',
			body: { name: 'tender.pdf', mime: 'application/pdf', bytes: 'AQID', options: {} }
		});
	});
	it('resumes a stream that ended before its result, by the job id', async () => {
		seen.length = 0;
		const got = await documentIngester({ url, key: 'k' }).ingest(
			file('cut.pdf'),
			{},
			new AbortController().signal
		);
		expect('kind' in got && got.kind === 'document' && got.html).toBe(result.html);
		expect(seen.map((s) => s.path)).toEqual(['/v1/ingest', '/v1/jobs/j9/events?result']);
	});
	it('answers a 415 as unsupported', async () => {
		expect(
			await documentIngester({ url, key: 'k' }).ingest(
				file('plan.dwg'),
				{},
				new AbortController().signal
			)
		).toEqual({ unsupported: 'no parser for CAD drawings' });
	});
	it('decodes a data ingest: its JSON as is, its images to bytes', async () => {
		expect(
			await documentIngester({ url, key: 'k' }).ingest(
				file('rates.xlsx'),
				{},
				new AbortController().signal
			)
		).toEqual({
			...sheet,
			images: [{ name: 'image-1.png', mime: 'image/png', bytes: new Uint8Array([0x89, 0x50]) }]
		});
	});
	it('passes the options and decodes an audio ingest with its usage', async () => {
		const got = await documentIngester({ url, key: 'k' }).ingest(
			file('meeting.m4a'),
			{ diarize: true, language: 'en', speakers: 2, prompt: 'Concrete pour' },
			new AbortController().signal
		);
		expect(got).toEqual(audio);
		expect(seen.at(-1)?.body).toMatchObject({
			name: 'meeting.m4a',
			options: { diarize: true, language: 'en', speakers: 2, prompt: 'Concrete pour' }
		});
	});
	it('rejects a 503 as the unavailable facility error', async () => {
		await expect(
			documentIngester({ url, key: 'k' }).ingest(file('mute.m4a'), {}, new AbortController().signal)
		).rejects.toEqual({
			kind: 'unavailable',
			facility: 'convert.ingest',
			reason: 'this converter has no transcription model'
		});
	});
});
