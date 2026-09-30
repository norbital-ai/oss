// `ctx.ai.transcribe` and `ctx.ai.speak` (optional host capabilities): the engine reads the FileRef and hands the host's
// SpeechPort its bytes; `speak`'s audio is stored like `files.put`. A host without the port answers `unavailable`.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest, SpeechPort } from '../src/engine/contracts.ts';
import { testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { calls: { description: 'A call', label: 'title', fields: { title: { kind: 'text' }, audio: { kind: 'file', accept: ['*/*'], max: '1MiB' } } } },
	relationships: {},
	collections: { calls: { read: { fields: 'all' }, create: { input: { columns: ['title', 'audio'] } } } },
	integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
	policies: { ops: { description: 'Ops', grants: { calls: { read: true } }, automations: ['listen', 'say'] } },
	automations: {
		listen: { description: 'Transcribes a call', runAs: ['ops'], input: { file: { kind: 'json' }, options: { kind: 'json' } } },
		say: { description: 'Speaks a line', runAs: ['ops'], input: { options: { kind: 'json' } } },
	},
} as unknown as EngineManifest;

const source = `export default { automation: {
	listen: { body: async ({ file, options }, ctx) => ctx.ai.transcribe.try(file, options) },
	say: { body: async ({ options }, ctx) => ctx.ai.speak.try('Hello there', { for: 'say', ...options }) } } };`;

const transcript = { segments: [{ speaker: 'S1', start: 0, end: 1.5, text: 'Hello.' }, { speaker: 'S2', start: 1.6, end: 3, text: 'Hi.' }], language: 'en', durationMs: 3000 };
const audio = new Uint8Array([0xff, 0xf3, 1, 2, 3]);

async function run(automation: 'listen' | 'say', input: (file: Json) => Json, speech?: SpeechPort) {
	const t = await testWorkspace({ manifest, guest: { source }, ...(speech === undefined ? {} : { speech }) });
	const admin = t.as(t.admin);
	const up = await admin.upload('calls.audio', { name: 'call.mp3', mime: 'audio/mpeg', bytes: audio });
	if (up.kind !== 'committed') throw new Error('upload failed');
	await admin.act('calls.create', { title: 'Call', audio: up.output });
	await t.as(t.member(['ops'])).start(automation, input(up.output), { id: randomUUID() });
	await t.runDue();
	const [row] = (await t.db.read([{ text: `SELECT state, output, error FROM sys_run`, params: [] }]))[0]!.rows;
	return { t, row: row!, output: row!['output'] as { [k: string]: Json } };
}

describe('ctx.ai.transcribe', () => {
	it('hands the port the stored bytes and the options, and answers its transcript', async () => {
		const seen: Parameters<NonNullable<SpeechPort['transcribe']>>[] = [];
		const { row, output } = await run('listen', (file) => ({ file, options: { diarize: true, speakers: 2, language: 'en' } }),
			{ transcribe: async (...args) => (seen.push(args), transcript) });
		expect(row).toMatchObject({ state: 'succeeded', error: null });
		expect(output).toEqual(transcript);
		const [file, options] = seen[0]!;
		expect(file).toMatchObject({ name: 'call.mp3', mime: 'audio/mpeg' });
		expect([...file.bytes]).toEqual([...audio]);
		expect(options).toEqual({ diarize: true, speakers: 2, language: 'en' });
	});

	it('answers unavailable without the port or its transcribe, and refuses a file the run cannot name', async () => {
		expect((await run('listen', (file) => ({ file, options: {} }))).output).toMatchObject({ kind: 'unavailable', facility: 'ai.transcribe' });
		expect((await run('listen', (file) => ({ file, options: {} }), { speak: async () => ({ bytes: audio, mime: 'audio/mpeg' }) })).output)
			.toMatchObject({ kind: 'unavailable', facility: 'ai.transcribe' });
		expect((await run('listen', () => ({ file: { id: randomUUID() }, options: {} }), { transcribe: async () => transcript })).output)
			.toMatchObject({ kind: 'invalid', message: expect.stringContaining('cannot read file') });
	});

	it('turns a port throw into upstream and a malformed answer into upstream', async () => {
		expect((await run('listen', (file) => ({ file, options: {} }), { transcribe: async () => { throw new Error('provider down'); } })).output)
			.toMatchObject({ kind: 'upstream', message: expect.stringContaining('provider down') });
		expect((await run('listen', (file) => ({ file, options: {} }), { transcribe: async () => ({ segments: 'no' }) as never })).output)
			.toMatchObject({ kind: 'upstream' });
		const limited = Object.assign(new Error('slow down'), { kind: 'rateLimited', status: 429 });
		expect((await run('listen', (file) => ({ file, options: {} }), { transcribe: async () => { throw limited; } })).output)
			.toMatchObject({ kind: 'rateLimited', message: 'slow down', status: 429 });
	});

	it('refuses options of the wrong shape before calling the port', async () => {
		let called = false;
		const { output } = await run('listen', (file) => ({ file, options: { speakers: 'two' } }), { transcribe: async () => (called = true, transcript) });
		expect(output).toMatchObject({ kind: 'invalid' });
		expect(called).toBe(false);
	});
});

describe('ctx.ai.speak', () => {
	it('stores the port\'s audio for its owner and answers the FileRef', async () => {
		const seen: unknown[] = [];
		const { t, row, output } = await run('say', () => ({ options: { voice: 'Kore', format: 'wav' } }),
			{ speak: async (...args) => (seen.push(args.slice(0, 2)), { bytes: audio, mime: 'audio/wav' }) });
		expect(row).toMatchObject({ state: 'succeeded', error: null });
		expect(seen).toEqual([['Hello there', { voice: 'Kore', format: 'wav' }]]);
		expect(output).toMatchObject({ name: 'speech.wav', mime: 'audio/wav', bytes: audio.byteLength });
		const [file] = (await t.db.read([{ text: `SELECT key, field FROM sys_file WHERE id = $1`, params: [String(output['id'])] }]))[0]!.rows;
		expect(file!['field']).toBe('say');
		expect([...await t.fakes.files.get(String(file!['key']), 1024, AbortSignal.timeout(1000))]).toEqual([...audio]);
	});

	it('defaults to mp3, refuses another format and answers unavailable without speak', async () => {
		const seen: unknown[] = [];
		await run('say', () => ({ options: { name: 'hi.mp3' } }), { speak: async (_t, o) => (seen.push(o), { bytes: audio, mime: 'audio/mpeg' }) });
		expect(seen).toEqual([{ format: 'mp3' }]);
		expect((await run('say', () => ({ options: { format: 'flac' } }), { speak: async () => ({ bytes: audio, mime: 'audio/flac' }) })).output)
			.toMatchObject({ kind: 'invalid' });
		expect((await run('say', () => ({ options: {} }), { transcribe: async () => transcript })).output).toMatchObject({ kind: 'unavailable', facility: 'ai.speak' });
	});
});
