import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pandoc, type Converter } from '../src/convert.ts';
import { openQueue } from '../src/queue.ts';
import { service, type Options } from '../src/server.ts';

const dir = mkdtempSync(join(tmpdir(), 'convert-test-'));
let n = 0;
const running: { stop: () => Promise<void> }[] = [];
after(() => Promise.all(running.map((s) => s.stop())));

async function start(o: Partial<Options> & { convert: Converter }) {
	const svc = service({ keys: ['k1', 'k2'], database: join(dir, `db-${n++}.db`), pollMs: 20, ...o });
	running.push(svc);
	await new Promise<void>((r) => svc.server.listen(0, r));
	const url = `http://localhost:${(svc.server.address() as AddressInfo).port}`;
	const call = (path: string, init: RequestInit & { key?: string } = {}) =>
		fetch(url + path, { ...init, headers: { authorization: `Bearer ${init.key ?? 'k1'}`, 'content-type': 'application/json', ...init.headers } });
	const submit = (body: object, key?: string) => call('/v1/jobs', { method: 'POST', body: JSON.stringify(body), ...(key ? { key } : {}) });
	/** Reads the job's event stream to its end and returns every state it reported. */
	const watch = async (id: string) => (await (await call(`/v1/jobs/${id}/events`)).text())
		.split('\n\n').filter((e) => e.startsWith('event: job')).map((e) => JSON.parse(e.split('data: ')[1]!) as { state: string; error: string | null });
	return { url, call, submit, watch };
}

const echo: Converter = async (r, ref) => new TextEncoder().encode(`${r.to}:${r.source}:${r.page ?? ''}:${r.landscape ?? ''}:${ref?.length ?? 0}`);

test('a key is required on every route but the health check', async () => {
	const s = await start({ convert: echo });
	assert.equal((await fetch(`${s.url}/healthz`)).status, 200);
	assert.equal((await fetch(`${s.url}/v1/jobs`, { method: 'POST' })).status, 401);
	assert.equal((await s.submit({ from: 'markdown', to: 'pdf', source: '# x' }, 'wrong')).status, 401);
});

test('submits, watches to the end and fetches the converted bytes', async () => {
	const s = await start({ convert: echo });
	const res = await s.submit({ from: 'markdown', to: 'pdf', source: '# Report', page: 'A3', landscape: true });
	assert.equal(res.status, 202);
	const job = (await res.json()) as { id: string; state: string };
	assert.equal(job.state, 'queued');
	assert.equal((await s.watch(job.id)).at(-1)!.state, 'succeeded');
	const out = await s.call(`/v1/jobs/${job.id}/result`);
	assert.equal(out.headers.get('content-type'), 'application/pdf');
	assert.equal(await out.text(), 'pdf:# Report:A3:true:0');
	const styled = (await (await s.submit({ from: 'html', to: 'docx', source: '<p>x</p>', reference: Buffer.from([1, 2, 3]).toString('base64') })).json()) as { id: string };
	await s.watch(styled.id);
	assert.equal(await (await s.call(`/v1/jobs/${styled.id}/result`)).text(), 'docx:<p>x</p>:::3');
});

test('a watcher on the replica that runs the job hears it settle at once, not on the next poll', async () => {
	const s = await start({ convert: echo });
	const t0 = Date.now();
	const { id } = (await (await s.submit({ from: 'markdown', to: 'html', source: 'x' })).json()) as { id: string };
	assert.equal((await s.watch(id)).at(-1)!.state, 'succeeded');
	assert.ok(Date.now() - t0 < 150, `${Date.now() - t0} ms`);
});

test('one call: /v1/convert queues the job and streams its states, then the bytes', async () => {
	const s = await start({ convert: echo });
	const res = await s.call('/v1/convert', { method: 'POST', body: JSON.stringify({ from: 'markdown', to: 'docx', source: '# R' }) });
	assert.equal(res.headers.get('content-type'), 'text/event-stream');
	const events = (await res.text()).split('\n\n').filter((e) => e.startsWith('event: '));
	// job events (queued, running — whichever it was in when first read — then succeeded), the result last
	assert.deepEqual([...new Set(events.map((e) => e.split('\n')[0]))], ['event: job', 'event: result']);
	assert.match(events.at(-2)!, /"state":"succeeded"/);
	const result = JSON.parse(events.at(-1)!.split('data: ')[1]!) as { mime: string; to: string; bytes: string };
	assert.equal(result.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
	assert.equal(Buffer.from(result.bytes, 'base64').toString(), 'docx:# R:::0');
	// a caller whose stream dropped resumes by the job id from the first event
	const { id } = JSON.parse(events[0]!.split('data: ')[1]!) as { id: string };
	assert.match(await (await s.call(`/v1/jobs/${id}/events?result`)).text(), /event: result/);
	assert.doesNotMatch(await (await s.call(`/v1/jobs/${id}/events`)).text(), /event: result/);
});

test('/v1/convert streams a failure as the settled job, with no result', async () => {
	const s = await start({ convert: async () => { throw new Error('bad input'); } });
	const text = await (await s.call('/v1/convert', { method: 'POST', body: JSON.stringify({ from: 'markdown', to: 'odt', source: 'x' }) })).text();
	assert.match(text, /"state":"failed","to":"odt","error":"bad input"/);
	assert.doesNotMatch(text, /event: result/);
});

test('another key cannot see the job', async () => {
	const s = await start({ convert: echo });
	const { id } = (await (await s.submit({ from: 'markdown', to: 'html', source: 'x' })).json()) as { id: string };
	assert.equal((await s.call(`/v1/jobs/${id}`, { key: 'k2' })).status, 404);
	assert.equal((await s.call(`/v1/jobs/${id}/result`, { key: 'k2' })).status, 404);
});

test('refuses a malformed request, options another target owns and a full queue', async () => {
	const s = await start({ convert: echo, concurrency: 0, maxQueued: 1 });
	const error = async (body: object) => ((await (await s.submit(body)).json()) as { error: string }).error;
	assert.match(await error({ from: 'rtf', to: 'pdf', source: 'x' }), /from is/);
	assert.match(await error({ from: 'markdown', to: 'xlsx', source: 'x' }), /to is one of/);
	assert.match(await error({ from: 'markdown', to: 'docx', source: 'x', page: 'A4' }), /page is a pdf's/);
	assert.match(await error({ from: 'markdown', to: 'pdf', source: 'x', reference: 'AQ==' }), /reference is base64/);
	assert.equal((await s.submit({ from: 'markdown', to: 'pdf', source: 'x' })).status, 202);
	assert.equal((await s.submit({ from: 'markdown', to: 'pdf', source: 'x' })).status, 429);
});

test('a failed conversion settles failed with the reason', async () => {
	const s = await start({ convert: async () => { throw new Error('bad input'); } });
	const { id } = (await (await s.submit({ from: 'markdown', to: 'odt', source: 'x' })).json()) as { id: string };
	assert.deepEqual((({ state, error }) => ({ state, error }))((await s.watch(id)).at(-1)!), { state: 'failed', error: 'bad input' });
	assert.equal((await s.call(`/v1/jobs/${id}/result`)).status, 409);
});

test('replicas share one queue: a job submitted to an idle replica is run by another', async () => {
	const database = join(dir, 'shared.db');
	const front = await start({ convert: echo, concurrency: 0, database });
	let ran = 0;
	await start({ convert: async (r, ref) => (ran++, echo(r, ref)), database });
	const { id } = (await (await front.submit({ from: 'markdown', to: 'epub', source: 'x' })).json()) as { id: string };
	assert.equal((await front.watch(id)).at(-1)!.state, 'succeeded');
	assert.equal(ran, 1);
	assert.equal(await (await front.call(`/v1/jobs/${id}/result`)).text(), 'epub:x:::0');
});

test('a job whose replica died is queued again, then failed after three attempts; the dead replica cannot overwrite it', () => {
	const q = openQueue(join(dir, 'lease.db'));
	const job = q.submit('o', 'pdf', '{}', null);
	for (let attempt = 1; attempt <= 3; attempt++) {
		assert.equal(q.claim(`w${attempt}`, -1)?.id, job.id);
		q.recover();
	}
	assert.equal(q.get('o', job.id)?.state, 'failed');
	assert.match(q.get('o', job.id)!.error!, /stopped 3 times/);
	q.finish(job.id, 'w3', { result: new Uint8Array([1]), mime: 'application/pdf' });
	assert.equal(q.get('o', job.id)?.state, 'failed');
	q.close();
});

const hasPandoc = (() => { try { execFileSync('pandoc', ['--version']); return true; } catch { return false; } })();
test('pandoc and Typst write every target', { skip: !hasPandoc && 'pandoc is not on PATH (runs in the image)' }, async () => {
	const convert = pandoc({ timeoutMs: 30_000, heap: '512m' });
	const md = '# Report\n\n| Panel | R-E (MΩ) |\n|---|--:|\n| 2A | 20,000 |\n\n45 µΩ at 31 °C';
	const head = async (to: 'pdf' | 'docx' | 'pptx' | 'odt' | 'epub') => new TextDecoder().decode((await convert({ from: 'markdown', to, source: md }, null)).slice(0, 4));
	assert.equal(await head('pdf'), '%PDF');
	for (const to of ['docx', 'pptx', 'odt', 'epub'] as const) assert.equal(await head(to), 'PK\u0003\u0004');
	assert.match(new TextDecoder().decode(await convert({ from: 'markdown', to: 'html', source: md }, null)), /45 µΩ at 31 °C/);
	const landscape = new TextDecoder('latin1').decode(await convert({ from: 'markdown', to: 'pdf', source: md, page: 'A3', landscape: true }, null));
	assert.match(landscape, /MediaBox \[0 0 1190\.\d+ 841\.\d+\]/);
	const reference = await convert({ from: 'markdown', to: 'docx', source: '# Letterhead' }, null);
	assert.equal(new TextDecoder().decode((await convert({ from: 'html', to: 'docx', source: '<h1>x</h1>' }, reference)).slice(0, 2)), 'PK');
	await assert.rejects(convert({ from: 'markdown', to: 'pdf', source: '```{=typst}\n#read("/etc/passwd")\n```' }, null));
});

test('Chinese typesets, a cell marker stays text, a docx is A4 and a data-URI logo is not its own description', { skip: !hasPandoc && 'pandoc is not on PATH (runs in the image)' }, async () => {
	const convert = pandoc({ timeoutMs: 30_000, heap: '512m' });
	const logo = '![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)';
	const md = `---\nheader-includes: "#let own = 1"\n---\n\n${logo}\n\n检测报告 Report\n\n| a | b |\n|---|---|\n| \\- none | 1\\. first |`;
	const pdf = new TextDecoder('latin1').decode(await convert({ from: 'markdown', to: 'pdf', source: md, landscape: true }, null));
	assert.match(pdf, /NotoSansCJKsc-Regular/);
	assert.match(pdf, /MediaBox \[0 0 841\.\d+ 595\.\d+\]/);
	const filter = new URL('../src/convert.lua', import.meta.url).pathname;
	const typst = execFileSync('pandoc', ['--standalone', '-t', 'typst', `--lua-filter=${filter}`], { input: md }).toString();
	assert.match(typst, /\[\\- none\], \[1\\\. first\]/);
	assert.match(typst, /#let own = 1/);
	const out = join(dir, 'a4.docx');
	writeFileSync(out, await convert({ from: 'markdown', to: 'docx', source: md }, null));
	const xml = execFileSync('unzip', ['-p', out, 'word/document.xml']).toString();
	assert.match(xml, /<w:pgSz w:h="16838" w:w="11906"/);
	assert.doesNotMatch(xml, /descr="data:/);
});
