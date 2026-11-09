// `documentIngester`: the agent's ingest port over Norbital Convert's job routes, against a fake service speaking its
// wire (the file posted raw, a job, its result: a document or data; a job still running; audio's usage; a 415 for a
// format with no parser; a 503 when it has no transcription model).
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
const seen: {
	path: string;
	auth: string | undefined;
	password: string | undefined;
	body: Buffer;
}[] = [];
const answers: { readonly [job: string]: unknown } = { j1: result, j2: audio, j3: sheet, j9: result };
const jobs: { readonly [file: string]: string } = {
	'rates.xlsx': 'j3',
	'meeting.m4a': 'j2',
	'cut.pdf': 'j9'
};
const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	const chunks: Buffer[] = [];
	req.on('data', (chunk: Buffer) => chunks.push(chunk));
	req.on('end', () => {
		const at = new URL(req.url ?? '/', 'http://localhost');
		seen.push({
			path: req.url ?? '',
			auth: req.headers.authorization,
			password: req.headers['x-ingest-password']?.toString(),
			body: Buffer.concat(chunks)
		});
		const name = at.searchParams.get('name');
		if (at.pathname.startsWith('/v1/kept/'))
			json(res, at.pathname.endsWith('/abc') ? 404 : 200, {});
		else if (at.pathname === '/v1/ingest/raw' && name === 'plan.dwg')
			json(res, 415, { error: 'unsupported', message: 'no parser for CAD drawings' });
		else if (at.pathname === '/v1/ingest/raw' && name === 'mute.m4a')
			json(res, 503, { error: 'unavailable', message: 'this converter has no transcription model' });
		else if (at.pathname === '/v1/ingest/raw') {
			const id = jobs[name ?? ''] ?? 'j1';
			json(res, 202, { id, state: id === 'j9' ? 'running' : 'succeeded', error: null });
		} else if (at.pathname.endsWith('/result')) json(res, 200, answers[at.pathname.split('/')[3] ?? '']);
		else json(res, 200, { id: at.pathname.split('/')[3], state: 'succeeded', error: null });
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
	it('posts the file as its body and decodes the result, images to bytes', async () => {
		const got = await documentIngester({ url, key: 'k' }).ingest(
			file('tender.pdf'),
			{},
			new AbortController().signal
		);
		expect(got).toEqual({
			...result,
			images: [{ name: 'image-1.png', mime: 'image/png', bytes: new Uint8Array([0x89, 0x50]) }]
		});
		const posted = seen.find((one) => one.path.startsWith('/v1/ingest/raw'));
		expect(posted?.auth).toBe('Bearer k');
		expect([...(posted?.body ?? [])]).toEqual([1, 2, 3]);
		expect(posted?.path).toContain('name=tender.pdf');
	});
	it('streams a stored file to the converter', async () => {
		seen.length = 0;
		await documentIngester({ url, key: 'k' }).ingest(
			{ ...file('tender.pdf'), bytes: new Blob([new Uint8Array([4, 5])]).stream() },
			{},
			new AbortController().signal
		);
		expect([...(seen[0]?.body ?? [])]).toEqual([4, 5]);
	});
	it('sends a file read from disk until Convert keeps it, then only its hash', async () => {
		const page = { page: 3 };
		seen.length = 0;
		await documentIngester({ url, key: 'k' }).ingest(file('tender.pdf'), page, new AbortController().signal);
		expect(seen[0]?.path).toBe('/v1/kept/abc');
		expect([...(seen[1]?.body ?? [])]).toEqual([1, 2, 3]);
		expect(seen[1]?.path).toContain('sha256=abc');
		seen.length = 0;
		await documentIngester({ url, key: 'k' }).ingest(
			{ ...file('tender.pdf'), sha256: 'def', bytes: new Blob([new Uint8Array([4, 5])]).stream() },
			page,
			new AbortController().signal
		);
		expect(seen[1]?.body.byteLength).toBe(0);
		expect(seen[1]?.path).toContain('sha256=def');
	});
	it('polls a job still running, then fetches its result', async () => {
		seen.length = 0;
		const got = await documentIngester({ url, key: 'k' }).ingest(
			file('cut.pdf'),
			{},
			new AbortController().signal
		);
		expect('kind' in got && got.kind === 'document' && got.html).toBe(result.html);
		expect(seen.map((one) => one.path.split('?')[0])).toEqual([
			'/v1/ingest/raw',
			'/v1/jobs/j9',
			'/v1/jobs/j9/result'
		]);
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
		seen.length = 0;
		const got = await documentIngester({ url, key: 'k' }).ingest(
			file('meeting.m4a'),
			{ diarize: true, language: 'en', speakers: 2, prompt: 'Concrete pour' },
			new AbortController().signal
		);
		expect(got).toEqual(audio);
		const posted = new URL(seen.find((one) => one.path.startsWith('/v1/ingest/raw'))?.path ?? '', url);
		expect(JSON.parse(posted.searchParams.get('options') ?? '')).toEqual({
			diarize: true,
			language: 'en',
			speakers: 2,
			prompt: 'Concrete pour'
		});
	});
	it('sends a password as its header, never in the URL', async () => {
		seen.length = 0;
		await documentIngester({ url, key: 'k' }).ingest(
			file('statement.pdf'),
			{ password: 'pâss 1' },
			new AbortController().signal
		);
		const posted = seen.find((one) => one.path.startsWith('/v1/ingest/raw'));
		expect(Buffer.from(posted?.password ?? '', 'base64').toString('utf8')).toBe('pâss 1');
		expect(decodeURIComponent(posted?.path ?? '')).not.toContain('pâss');
		const options = new URL(posted?.path ?? '', url).searchParams.get('options');
		expect(JSON.parse(options ?? '')).toEqual({});
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
