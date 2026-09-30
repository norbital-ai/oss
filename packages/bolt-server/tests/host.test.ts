// bolt start's host facilities (§5.11.6, rule 69): the S3 files store, the Postgres TLS
// default, and activation's requirements. One test per guarantee; the MinIO round trip runs when BOLT_TEST_S3 names a
// bucket (`<url>|<access key>:<secret>`).
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import type { EngineManifest } from '../../bolt/src/engine/contracts.ts';
import { decodeConfig } from '../src/config.ts';
import { s3Files } from '../src/ports.ts';
import { pgOptions, requirements } from '../src/server.ts';

const servers: HttpServer[] = [];
afterAll(() => { for (const s of servers) s.close(); });
/** A loopback HTTP server; `handle` answers each request with its body read. */
async function serve(handle: (method: string, url: URL, headers: { [k: string]: string | string[] | undefined }, body: Buffer) => { status: number; body?: string | Buffer; json?: unknown }): Promise<string> {
	const s = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c)).on('end', () => {
			const r = handle(req.method!, new URL(req.url!, 'http://x'), req.headers, Buffer.concat(chunks));
			res.writeHead(r.status, r.json === undefined ? {} : { 'content-type': 'application/json' }).end(r.json === undefined ? r.body : JSON.stringify(r.json));
		});
	});
	servers.push(s);
	await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
	const a = s.address();
	return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
}
const signal = () => AbortSignal.timeout(5_000);

describe('the S3 files store (BOLT_FILES_PROVIDER=s3)', () => {
	it('presigns exactly as AWS documents (SigV4 known answer)', async () => {
		const s3 = s3Files('https://examplebucket.s3.amazonaws.com', 'AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', fetch, () => new Date('2013-05-24T00:00:00Z'));
		const url = new URL(await s3.url('test.txt', 86_400, signal()));
		expect(url.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
	});

	it('puts, gets within the bound, and removes signed objects under the bucket path', async () => {
		const objects = new Map<string, Buffer>();
		const base = await serve((method, url, headers, body) => {
			if (!String(headers['authorization']).startsWith('AWS4-HMAC-SHA256 Credential=ak/')) return { status: 403 };
			if (method === 'PUT') { objects.set(url.pathname, body); return { status: 200 }; }
			if (method === 'GET') return objects.has(url.pathname) ? { status: 200, body: objects.get(url.pathname)! } : { status: 404 };
			objects.delete(url.pathname);
			return { status: 204 };
		});
		const s3 = s3Files(`${base}/bucket?region=auto`, 'ak:sk');
		const blob = await s3.put(new TextEncoder().encode('hello'), { name: 'a.txt', mime: 'text/plain' }, signal());
		expect([...objects.keys()]).toEqual([`/bucket/${blob.key}`]);
		expect(new TextDecoder().decode(await s3.get(blob.key, 100, signal()))).toBe('hello');
		await expect(s3.get(blob.key, 2, signal())).rejects.toThrow(/larger than 2 bytes/);
		await s3.remove(blob.key, signal());
		expect(objects.size).toBe(0);
		await expect(s3.get('../other', 1, signal())).rejects.toThrow(/not a file key/);
	});

	const minio = process.env['BOLT_TEST_S3'];
	it.skipIf(minio === undefined)('round-trips against a real S3-compatible store', async () => {
		const [endpoint, credential] = minio!.split('|') as [string, string];
		const s3 = s3Files(endpoint, credential);
		const blob = await s3.put(new TextEncoder().encode('minio'), { name: 'm.txt', mime: 'text/plain' }, signal());
		expect(new TextDecoder().decode(await s3.get(blob.key, 100, signal()))).toBe('minio');
		expect(await (await fetch(await s3.url(blob.key, 60, signal()))).text()).toBe('minio');
		await s3.remove(blob.key, signal());
		await expect(s3.get(blob.key, 100, signal())).rejects.toThrow(/404/);
	});
});

describe('the Postgres URL (§5.11.6)', () => {
	it('requires TLS unless the URL names an sslmode', () => {
		expect(pgOptions('postgres://u:p@db.example/app')).toMatchObject({ ssl: true });
		expect(pgOptions('postgres://u:p@127.0.0.1/app?sslmode=disable')).not.toHaveProperty('ssl');
	});
});

describe('activation requirements (rule 69)', () => {
	const config = (over: { [k: string]: string } = {}) => decodeConfig({ BOLT_ARTIFACT: '/a', BOLT_PGLITE_DIR: '/d', BOLT_PUBLIC_URL: 'http://localhost:3100',
		BOLT_FILES_PROVIDER: 'local', BOLT_FILES_ENDPOINT: '/f', ...over });
	const manifest = (over: object = {}) => ({ workspace: { tz: 'UTC' }, models: {}, collections: {}, channels: {}, connections: {}, apps: {}, agent: {}, envoys: {}, ...over }) as unknown as EngineManifest;
	const errors = (c: ReturnType<typeof config>, m: EngineManifest, dev = false) => requirements(c, m, { dev }).errors.join('\n');

	it('reads speech (BOLT_AI_SPEECH_*) as its own optional facility with a model per capability', () => {
		expect(config().speech).toBeNull();
		const on = { BOLT_AI_SPEECH_PROVIDER: 'openrouter', BOLT_AI_SPEECH_CREDENTIAL: 'k' };
		expect(config({ ...on, BOLT_AI_TRANSCRIBE_MODEL: 'google/gemini-3.5-flash' }).speech)
			.toEqual({ endpoint: 'https://openrouter.ai/api/v1', credential: 'k', transcribe: 'google/gemini-3.5-flash', speak: null, voice: null });
		expect(config({ ...on, BOLT_AI_SPEECH_ENDPOINT: 'https://or.test/v1', BOLT_AI_SPEAK_MODEL: 'tts', BOLT_AI_SPEAK_VOICE: 'Kore' }).speech)
			.toMatchObject({ endpoint: 'https://or.test/v1', transcribe: null, speak: 'tts', voice: 'Kore' });
		expect(() => config({ ...on })).toThrow(/BOLT_AI_TRANSCRIBE_MODEL or BOLT_AI_SPEAK_MODEL/);
		expect(() => config({ BOLT_AI_SPEECH_PROVIDER: 'openrouter', BOLT_AI_TRANSCRIBE_MODEL: 'm' })).toThrow(/BOLT_AI_SPEECH_CREDENTIAL/);
		expect(() => config({ BOLT_AI_TRANSCRIBE_MODEL: 'm' })).toThrow(/BOLT_AI_SPEECH_PROVIDER/);
		expect(() => config({ ...on, BOLT_AI_SPEECH_PROVIDER: 'acme', BOLT_AI_TRANSCRIBE_MODEL: 'm' })).toThrow(/not registered/);
	});

	it('--dev / BOLT_DEV runs only on a loopback origin outside production (L-BOLT-366)', () => {
		expect(config().dev).toBe(false);
		expect(config({ BOLT_DEV: '1' }).dev).toBe(true);
		expect(decodeConfig({ BOLT_ARTIFACT: '/a', BOLT_PGLITE_DIR: '/d', BOLT_PUBLIC_URL: 'http://localhost:3100' }, ['--dev']).dev).toBe(true);
		expect(() => config({ BOLT_DEV: 'yes' })).toThrow(/BOLT_DEV/);
		expect(() => config({ BOLT_DEV: '1', BOLT_ENVIRONMENT: 'production' })).toThrow(/production/);
		expect(() => config({ BOLT_DEV: '1', BOLT_PUBLIC_URL: 'https://acme.example' })).toThrow(/loopback/);
	});

	it('needs the master key for declared secrets and OAuth2 connections, Turnstile for a challenged app, a model for every declared class', () => {
		expect(errors(config(), manifest())).toBe('');
		expect(errors(config(), manifest({ workspace: { tz: 'UTC', env: { API_KEY: { secret: true } } } }))).toMatch(/BOLT_MASTER_KEY/);
		expect(errors(config(), manifest({ connections: { crm: { auth: { oauth2: { grant: 'client_credentials' } } } } }))).toMatch(/BOLT_MASTER_KEY/);
		const challenged = manifest({ apps: { kiosk: { audience: { visitors: { challenge: 'turnstile' } } } } });
		expect(errors(config(), challenged)).toMatch(/BOLT_TURNSTILE/);
		expect(errors(config(), challenged, true)).toBe(''); // bolt dev's dev Turnstile
		const ai = manifest({ workspace: { tz: 'UTC', ai: { models: ['default', 'fast'] } } });
		const both = { BOLT_AI_SYS_1_PROVIDER: 'openai', BOLT_AI_SYS_1_MODEL: 't', BOLT_AI_SYS_2_PROVIDER: 'openai' };
		expect(errors(config({ ...both, BOLT_AI_SYS_2_MODELS: '{"default":"gpt"}' }), ai)).toMatch(/BOLT_AI_SYS_2_MODELS maps no model to fast/);
		// the AI facility is sys_1 and sys_2 together (P35): one without the other refuses to start
		expect(() => config({ BOLT_AI_SYS_2_PROVIDER: 'openai', BOLT_AI_SYS_2_MODELS: '{"default":"gpt","fast":"g"}' })).toThrow(/BOLT_AI_SYS_1_PROVIDER/);
		expect(errors(config({ ...both, BOLT_AI_SYS_2_MODELS: '{"default":"gpt","fast":"g"}' }), ai)).toBe('');
		// sys_1 on the Decisions API names its URL and key
		expect(() => config({ ...both, BOLT_AI_SYS_1_PROVIDER: 'decisions' })).toThrow(/BOLT_AI_SYS_1_ENDPOINT/);
		expect(() => config({ ...both, BOLT_AI_SYS_1_PROVIDER: 'decisions', BOLT_AI_SYS_1_ENDPOINT: 'https://d.test', BOLT_AI_SYS_1_CREDENTIAL: 'k' })).not.toThrow();
		expect(requirements(config(), ai, {}).warnings.join('\n')).toMatch(/AI is not configured.*without triage and the AI filter is hidden/);
		expect(requirements(config(), manifest({ agent: { internal: 'You help.' } }), {}).warnings.join('\n')).toMatch(/AI is not configured/); // the agent needs one too
		// the engine reads files (§5.8.1): a file field warns of nothing
		expect(requirements(config(), manifest({ models: { photos: { fields: { photo: { kind: 'file' } } } } }), {}).warnings.join('\n')).not.toMatch(/files\./);
		// a deployed host needs the host's messaging; a local one prints it to its log
		expect(errors(decodeConfig({ BOLT_ARTIFACT: '/a', BOLT_PGLITE_DIR: '/d', BOLT_PUBLIC_URL: 'https://acme.example' }), manifest()))
			.toMatch(/files are required[\s\S]*BOLT_TRANSACTIONAL_EMAIL/);
		expect(errors(decodeConfig({ BOLT_ARTIFACT: '/a', BOLT_PGLITE_DIR: '/d', BOLT_PUBLIC_URL: 'http://localhost:3100', BOLT_FILES_PROVIDER: 'local', BOLT_FILES_ENDPOINT: '/f' }), manifest())).toBe('');
		expect(errors(config({ BOLT_ENVIRONMENT: 'production' }), manifest())).toMatch(/BOLT_TRANSACTIONAL_EMAIL/);
		// phone sign-up needs a phone provider on a deployed host
		const phone = manifest({ workspace: { tz: 'UTC', signup: { via: ['phone'], policies: [] } } });
		const deployed = { BOLT_PUBLIC_URL: 'https://acme.example', BOLT_TRANSACTIONAL_EMAIL: 'resend', BOLT_RESEND_API_KEY: 're_k' };
		expect(errors(config(deployed), phone)).toMatch(/BOLT_TRANSACTIONAL_PHONE/);
		expect(errors(config({ ...deployed, BOLT_TRANSACTIONAL_PHONE: 'twilio', BOLT_TWILIO_ACC_SID: 'AC1', BOLT_TWILIO_AUTH_TOKEN: 't' }), phone)).toBe('');
	});

	it('binds ctx.convert to Norbital Convert, and warns of declared targets when it is absent', () => {
		const converts = manifest({ workspace: { tz: 'UTC', convert: { to: ['pdf', 'docx'] } } });
		const warned = (c: ReturnType<typeof config>) => requirements(c, converts, {}).warnings.join('\n');
		expect(warned(config())).toMatch(/converts to pdf, docx but no converter is configured \(BOLT_CONVERT_PROVIDER=norbital\)/);
		expect(warned(config({ BOLT_CONVERT_PROVIDER: 'norbital', BOLT_CONVERT_ENDPOINT: 'http://convert:8080', BOLT_CONVERT_CREDENTIAL: 'k' }))).not.toMatch(/converts to/);
		expect(() => config({ BOLT_CONVERT_PROVIDER: 'norbital', BOLT_CONVERT_ENDPOINT: 'http://convert:8080' })).toThrow(/BOLT_CONVERT_CREDENTIAL, its API key/);
		expect(() => config({ BOLT_CONVERT_PROVIDER: 'pandoc', BOLT_CONVERT_ENDPOINT: 'http://x', BOLT_CONVERT_CREDENTIAL: 'k' })).toThrow(/not registered on this host \(norbital\)/);
	});

	it('decodes the s3 files provider and refuses it half-configured', () => {
		expect(config({ BOLT_FILES_PROVIDER: 's3', BOLT_FILES_ENDPOINT: 'https://r2.example/bucket', BOLT_FILES_CREDENTIAL: 'ak:sk' }).files)
			.toEqual({ provider: 's3', endpoint: 'https://r2.example/bucket', credential: 'ak:sk' });
		expect(() => config({ BOLT_FILES_PROVIDER: 's3', BOLT_FILES_ENDPOINT: 'https://r2.example/bucket' })).toThrow(/BOLT_FILES_CREDENTIAL/);
	});
});

describe('web reads (BOLT_WEB_PROVIDER=public)', () => {
	it('answers the page as text with its title; a refused read throws', async () => {
		const { publicWeb } = await import('../src/ports.ts');
		const ok = publicWeb(async () => ({ url: 'https://x.example/', body: '<title>Hi</title><script>x()</script><p>Hello <b>world</b></p>' }));
		expect(await ok.read('https://x.example', AbortSignal.timeout(1000))).toEqual({ url: 'https://x.example/', title: 'Hi', text: 'Hi Hello world' });
		const no = publicWeb(async () => { throw new Error('Public-page retrieval cannot reach private or reserved networks.'); });
		await expect(no.read('https://10.0.0.1', AbortSignal.timeout(1000))).rejects.toThrow(/private/);
	});

	it('carries the content type, digest and page count, and the raw HTML with its links when asked', async () => {
		const { facilities, publicWeb } = await import('../src/ports.ts');
		const page = { url: 'https://x.example/a/', contentType: 'text/html; charset=utf-8', sha256: 'f'.repeat(64),
			body: '<title>Hi</title><a href="b.pdf">B</a> <a href="https://y.example/c">C</a> <a href="mailto:x@y">M</a> <a href="#top">T</a>' };
		const web = publicWeb(async () => page);
		expect(await web.read('https://x.example/a/', AbortSignal.timeout(1000))).toEqual({ url: page.url, title: 'Hi', text: 'Hi B C M T',
			contentType: page.contentType, sha256: page.sha256 });
		const facility = facilities({ web, db: {} as never });
		const raw = await facility({ op: 'facility', facility: 'web', method: 'read', args: [page.url, { raw: true }] }, AbortSignal.timeout(1000));
		expect(raw).toMatchObject({ ok: true, value: { html: page.body, links: ['https://x.example/a/b.pdf', 'https://y.example/c'] } });
		const pdf = publicWeb(async () => ({ url: 'https://x.example/n.pdf', contentType: 'application/pdf', sha256: 'e'.repeat(64), pageCount: 3, body: 'Notice text' }));
		expect(await pdf.read('https://x.example/n.pdf', AbortSignal.timeout(1000), { raw: true })).toEqual({ url: 'https://x.example/n.pdf', title: null,
			text: 'Notice text', contentType: 'application/pdf', sha256: 'e'.repeat(64), pages: 3 });
	});
});
