// `ctx.convert.document` (optional host capability): Markdown or HTML to a target the workspace declares, over the host's
// ConvertPort, stored like `files.put`; then the provider against Norbital Convert, the service behind that port.
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { service } from '../../../services/convert/src/server.ts';
import type { Json } from '../src/decl/values.ts';
import type { ConvertPort, EngineManifest } from '../src/engine/contracts.ts';
import { documentConverter } from '../src/engine/convert.ts';
import { testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', convert: { to: ['pdf', 'docx'] } },
	models: { docs: { description: 'A document', label: 'title', fields: { title: { kind: 'text' }, file: { kind: 'file', accept: ['*/*'], max: '1MiB' } } } },
	relationships: {},
	collections: { docs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'file'] } } } },
	integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
	policies: { ops: { description: 'Ops', grants: { docs: { read: true } }, automations: ['make'] } },
	automations: { make: { description: 'Converts a document', runAs: ['ops'], input: { options: { kind: 'json' } } } },
} as unknown as EngineManifest;

const source = `export default { automation: { make: { body: async ({ options }, ctx) =>
	ctx.convert.document.try({ markdown: '# Report\\n\\n45 µΩ at 31 °C' }, { name: 'out', for: 'make', ...options }) } } };`;

type Call = Parameters<ConvertPort['convert']>;
const fake = (targets: ConvertPort['targets'], calls: Call[] = []): ConvertPort => ({
	targets, async convert(...args) { calls.push(args); return new TextEncoder().encode(`converted to ${args[1]}`); }
});

async function make(options: Json, convert?: ConvertPort, reference?: Uint8Array) {
	const t = await testWorkspace({ manifest, guest: { source }, ...(convert === undefined ? {} : { convert }) });
	const admin = t.as(t.admin);
	let ref: Json | undefined;
	if (reference !== undefined) {
		const up = await admin.upload('docs.file', { name: 'letterhead.docx', mime: 'application/octet-stream', bytes: reference });
		if (up.kind !== 'committed') throw new Error('upload failed');
		await admin.act('docs.create', { title: 'Letterhead', file: up.output });
		ref = up.output;
	}
	await t.as(t.member(['ops'])).start('make', { options: { ...(options as object), ...(ref === undefined ? {} : { reference: ref }) } }, { id: randomUUID() });
	await t.runDue();
	const [run] = (await t.db.read([{ text: `SELECT state, output, error FROM sys_run`, params: [] }]))[0]!.rows;
	return { t, run: run!, output: run!['output'] as { id?: string; mime?: string; kind?: string; message?: string; reason?: string } };
}

describe('ctx.convert.document', () => {
	it('converts to a declared target, hands the port the reference bytes and stores the output for its owner', async () => {
		const calls: Call[] = [];
		const letterhead = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
		const { t, run, output } = await make({ to: 'docx' }, fake(['pdf', 'docx'], calls), letterhead);
		expect(run).toMatchObject({ state: 'succeeded', error: null });
		expect(calls).toHaveLength(1);
		const [src, to, opts] = calls[0]!;
		expect(src).toEqual({ markdown: '# Report\n\n45 µΩ at 31 °C' });
		expect(to).toBe('docx');
		expect([...opts.reference!]).toEqual([...letterhead]);
		expect(output).toMatchObject({ name: 'out', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
		const [row] = (await t.db.read([{ text: `SELECT key, field FROM sys_file WHERE id = $1`, params: [output.id!] }]))[0]!.rows;
		expect(row!['field']).toBe('make');
		const stored = await t.fakes.files.get(String(row!['key']), 1024, new AbortController().signal);
		expect(new TextDecoder().decode(stored)).toBe('converted to docx');
	});

	it('passes a PDF its paper and orientation', async () => {
		const calls: Call[] = [];
		await make({ to: 'pdf', page: 'Letter', landscape: true }, fake(['pdf'], calls));
		expect(calls[0]![2]).toEqual({ page: 'Letter', landscape: true });
	});

	it('refuses an undeclared target and options another target owns', async () => {
		expect((await make({ to: 'pptx' }, fake(['pdf', 'docx', 'pptx']))).output).toMatchObject({ kind: 'invalid', message: expect.stringContaining("'pptx' is not declared") });
		expect((await make({ to: 'pdf', page: 'A5' }, fake(['pdf']))).output).toMatchObject({ kind: 'invalid', message: expect.stringContaining('A4, A3 or Letter') });
		expect((await make({ to: 'docx', landscape: true }, fake(['docx']))).output).toMatchObject({ kind: 'invalid', message: expect.stringContaining("a pdf's") });
		expect((await make({ to: 'pdf' }, fake(['pdf']), new Uint8Array([1]))).output).toMatchObject({ kind: 'invalid', message: expect.stringContaining('takes no reference') });
	});

	it('answers unavailable when the host binds no converter, or one that serves no such target', async () => {
		expect((await make({ to: 'pdf' })).output).toMatchObject({ kind: 'unavailable', facility: 'convert' });
		expect((await make({ to: 'pdf' }, fake(['docx']))).output).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('no pdf') });
	});
});

// The provider against the service itself (oss/services/convert), in process with a stand-in converter, so the wire shapes
// are the service's own; the live test runs pandoc and Typst when BOLT_TEST_CONVERT_URL / BOLT_TEST_CONVERT_KEY name one.
describe('documentConverter (Norbital Convert)', () => {
	const seen: unknown[] = [];
	let url = '', stop = async () => {};
	beforeAll(async () => {
		const svc = service({ keys: ['k'], database: join(mkdtempSync(join(tmpdir(), 'bolt-convert-')), 'jobs.db'), pollMs: 20,
			convert: async (request, reference) => {
				seen.push({ ...request, reference: reference && [...reference] });
				if (request.source === 'fail') throw new Error('pandoc: unreadable input');
				return new TextEncoder().encode(`${request.to} bytes`);
			} });
		await new Promise<void>((r) => svc.server.listen(0, r));
		url = `http://localhost:${(svc.server.address() as AddressInfo).port}`;
		stop = svc.stop;
	});
	afterAll(() => stop());
	const signal = () => AbortSignal.timeout(10_000);

	it('serves every target, submitting the job and fetching its bytes once it settles', async () => {
		const port = documentConverter({ url, key: 'k' });
		expect(port.targets).toEqual(['pdf', 'docx', 'pptx', 'odt', 'epub', 'html']);
		expect(new TextDecoder().decode(await port.convert({ markdown: '# R' }, 'pdf', { page: 'A3', landscape: true }, signal()))).toBe('pdf bytes');
		await port.convert({ html: '<p>x</p>' }, 'docx', { reference: new Uint8Array([1, 2, 3]) }, signal());
		expect(seen).toEqual([
			{ from: 'markdown', to: 'pdf', source: '# R', page: 'A3', landscape: true, reference: null },
			{ from: 'html', to: 'docx', source: '<p>x</p>', reference: [1, 2, 3] }
		]);
	});

	it('resumes a stream cut after its first event, by the job id, and still returns the bytes', async () => {
		let cut = 0;
		const cutting = (async (input: string, init: RequestInit) => {
			const res = await fetch(input, init);
			if (!input.endsWith('/v1/convert') || res.body === null) return res;
			const reader = res.body.getReader();
			const first = await reader.read();
			void reader.cancel();
			cut++;
			return new Response(new ReadableStream({ start(c) { c.enqueue(first.value); }, pull(c) { c.error(new TypeError('terminated')); } }), { status: 200 });
		}) as unknown as typeof fetch;
		const bytes = await documentConverter({ url, key: 'k', fetch: cutting }).convert({ markdown: '# R' }, 'epub', {}, signal());
		expect(cut).toBe(1);
		expect(new TextDecoder().decode(bytes)).toBe('epub bytes');
	});

	it('surfaces a failed conversion and a refused key', async () => {
		await expect(documentConverter({ url, key: 'k' }).convert({ markdown: 'fail' }, 'odt', {}, signal())).rejects.toThrow('pandoc: unreadable input');
		await expect(documentConverter({ url, key: 'wrong' }).convert({ markdown: 'x' }, 'odt', {}, signal())).rejects.toThrow(/answered 401/);
	});
});

const live = { url: process.env['BOLT_TEST_CONVERT_URL'], key: process.env['BOLT_TEST_CONVERT_KEY'] };
describe.skipIf(live.url === undefined || live.key === undefined)('documentConverter against a live service', () => {
	const port = documentConverter({ url: live.url ?? '', key: live.key ?? '' });
	const md = { markdown: '# Report\n\n| Panel | R-E (MΩ) |\n|---|--:|\n| 2A | 20,000 |\n\n45 µΩ at 31 °C' };
	const run = (to: Parameters<ConvertPort['convert']>[1], options = {}) => port.convert(md, to, options, AbortSignal.timeout(30_000));

	it('writes every target as its own format', async () => {
		const magic = async (to: Parameters<ConvertPort['convert']>[1]) => new TextDecoder().decode((await run(to)).slice(0, 4));
		expect(await magic('pdf')).toBe('%PDF');
		for (const to of ['docx', 'pptx', 'odt', 'epub'] as const) expect(await magic(to)).toBe('PK\u0003\u0004');
		expect(new TextDecoder().decode(await run('html'))).toContain('45 µΩ at 31 °C');
	});

	it('styles a docx with a reference document', async () => {
		const reference = await run('docx');
		expect(new TextDecoder().decode((await run('docx', { reference })).slice(0, 2))).toBe('PK');
	});
});
