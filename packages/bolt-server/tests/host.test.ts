// bolt start's host facilities (§5.11.6, rule 69): the S3 files store, the Postgres TLS
// default, and activation's requirements. One test per guarantee; the MinIO round trip runs when BOLT_TEST_S3 names a
// bucket (`<url>|<access key>:<secret>`).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it } from '@effect/vitest';
import {
	Config as EffectConfig,
	ConfigProvider,
	Effect,
	Layer,
	Option,
	Predicate,
	Schema
} from 'effect';
import { TestClock } from 'effect/testing';
import { FetchHttpClient } from 'effect/http';
import {
	EngineManifestSchema,
	Facilities,
	WebRead,
	type EngineManifest
} from '@norbital-ai/bolt/engine';
import { TestWorkspace } from '@norbital-ai/bolt/test';
import { FacilityFailure } from '@norbital-ai/bolt/errors';
import { BoltConfig, type Config, type StartFlags } from '../src/config.ts';
import { s3Files } from '../src/ports.ts';
import { pgOptions } from '../src/server.ts';
import { requirements } from '../src/activate.ts';
import { publicWeb } from '../src/web.ts';

const configured = (values: Readonly<Record<string, string>>, flags: StartFlags = {}) =>
	BoltConfig(flags).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))));
/** A loopback HTTP server; `handle` answers each request with its body read. */
const serve = Effect.fn('HostTest.serve')(function* (
	handle: (
		method: string,
		url: URL,
		headers: { [k: string]: string | string[] | undefined },
		body: Buffer
	) => { status: number; body?: string | Buffer; json?: unknown; headers?: { [k: string]: string } }
) {
	const s = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createServer((req, res) => {
				const chunks: Buffer[] = [];
				req
					.on('data', (c: Buffer) => chunks.push(c))
					.on('end', () => {
						const r = handle(
							req.method!,
							new URL(req.url!, 'http://x'),
							req.headers,
							Buffer.concat(chunks)
						);
						res
							.writeHead(
								r.status,
								r.json === undefined ? (r.headers ?? {}) : { 'content-type': 'application/json' }
							)
							.end(r.json === undefined ? r.body : JSON.stringify(r.json));
					});
			})
		),
		(server) =>
			Effect.promise(
				() =>
					new Promise<void>((resolve) => {
						server.close(() => resolve());
					})
			)
	);
	yield* Effect.callback<void, FacilityFailure>((resume) => {
		const failed = (error: Error) =>
			resume(Effect.fail(new FacilityFailure({ kind: 'upstream', message: error.message })));
		s.once('error', failed);
		s.listen(0, '127.0.0.1', () => resume(Effect.void));
		return Effect.sync(() => {
			s.off('error', failed);
		});
	});
	const a = s.address();
	return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
});

describe('the S3 files store (BOLT_FILES_PROVIDER=s3)', () => {
	it.effect('presigns exactly as AWS documents (SigV4 known answer)', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(Date.parse('2013-05-24T00:00:00Z'));
			const s3 = yield* s3Files(
				'https://examplebucket.s3.amazonaws.com',
				'AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
			).pipe(Effect.provide(FetchHttpClient.layer));
			const url = new URL(yield* s3.url('test.txt', 86_400));
			expect(url.searchParams.get('X-Amz-Signature')).toBe(
				'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
			);
		})
	);

	it.live('puts, gets within the bound, and removes signed objects under the bucket path', () =>
		Effect.gen(function* () {
			const objects = new Map<string, Buffer>();
			let uploadedMime: string | string[] | undefined;
			const base = yield* serve((method, url, headers, body) => {
				if (!String(headers['authorization']).startsWith('AWS4-HMAC-SHA256 Credential=ak/'))
					return { status: 403 };
				if (method === 'PUT') {
					uploadedMime = headers['content-type'];
					objects.set(url.pathname, body);
					return { status: 200 };
				}
				if (method === 'GET')
					return objects.has(url.pathname)
						? { status: 200, body: objects.get(url.pathname)! }
						: { status: 404 };
				objects.delete(url.pathname);
				return { status: 204 };
			});
			const s3 = yield* s3Files(`${base}/bucket?region=auto`, 'ak:sk').pipe(
				Effect.provide(FetchHttpClient.layer)
			);
			const blob = yield* s3.put(new TextEncoder().encode('hello'), {
				name: 'a.txt',
				mime: 'text/plain'
			});
			expect(uploadedMime).toBe('text/plain');
			expect([...objects.keys()]).toEqual([`/bucket/${blob.key}`]);
			expect(new TextDecoder().decode(yield* s3.get(blob.key, 100))).toBe('hello');
			expect(yield* Effect.flip(s3.get(blob.key, 2))).toMatchObject({
				message: expect.stringMatching(/larger than 2 bytes/)
			});
			yield* s3.remove(blob.key);
			expect(objects.size).toBe(0);
			expect(yield* Effect.flip(s3.get('../other', 1))).toMatchObject({
				message: expect.stringMatching(/not a file key/)
			});
		})
	);

	it.live('downloads media from a URL into a multipart upload, and aborts what it refuses', () =>
		Effect.gen(function* () {
			const png = Buffer.concat([
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				Buffer.alloc(10_000, 7)
			]);
			const objects = new Map<string, Buffer>(),
				uploads = new Map<string, Buffer[]>();
			let completed = '',
				begun = 0;
			const base = yield* serve((method, url, headers, body) => {
				// the origin the agent named: a PNG sent as octet-stream, and source code
				if (url.pathname === '/origin/seal.png')
					return {
						status: 200,
						body: png,
						headers: { 'content-type': 'application/octet-stream' }
					};
				if (url.pathname === '/origin/index.ts')
					return { status: 200, body: 'export const answer = 42;\n'.repeat(400) };
				if (!String(headers['authorization']).startsWith('AWS4-HMAC-SHA256 Credential=ak/'))
					return { status: 403 };
				const id = url.searchParams.get('uploadId') ?? '';
				if (method === 'POST' && url.searchParams.has('uploads')) {
					const next = `u${++begun}`;
					uploads.set(next, []);
					return {
						status: 200,
						body: `<InitiateMultipartUploadResult><UploadId>${next}</UploadId></InitiateMultipartUploadResult>`
					};
				}
				const parts = uploads.get(id);
				if (parts === undefined) return { status: 404 };
				if (method === 'PUT') {
					const n = Number(url.searchParams.get('partNumber'));
					parts[n - 1] = body;
					return { status: 200, headers: { etag: `"e${n}"` } };
				}
				uploads.delete(id);
				if (method === 'POST') {
					completed = body.toString();
					objects.set(url.pathname, Buffer.concat(parts));
					return { status: 200, body: '<CompleteMultipartUploadResult/>' };
				}
				return { status: 204 };
			});
			const s3 = yield* s3Files(`${base}/bucket?region=auto`, 'ak:sk', {
				allowLoopback: true
			}).pipe(Effect.provide(FetchHttpClient.layer));
			const file = yield* s3.download(`${base}/origin/seal.png`);
			expect(file).toMatchObject({
				mime: 'image/png',
				name: 'seal.png',
				bytes: png.byteLength,
				sha256: createHash('sha256').update(png).digest('hex')
			});
			expect(objects.get(`/bucket/${file.key}`)?.equals(png)).toBe(true);
			expect(completed).toBe(
				'<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"e1"</ETag></Part></CompleteMultipartUpload>'
			);
			expect(yield* Effect.flip(s3.download(`${base}/origin/index.ts`))).toMatchObject({
				kind: 'invalid'
			});
			const capped = yield* s3Files(`${base}/bucket?region=auto`, 'ak:sk', {
				allowLoopback: true,
				maxBytes: 6000
			}).pipe(Effect.provide(FetchHttpClient.layer));
			expect(yield* Effect.flip(capped.download(`${base}/origin/seal.png`))).toMatchObject({
				kind: 'invalid'
			});
			// the refused body began no upload; the capped one was aborted: no object, no open upload
			expect(objects.size).toBe(1);
			expect(uploads.size).toBe(0);
		})
	);

	it.live('round-trips against a real S3-compatible store', (context) =>
		Effect.gen(function* () {
			const minio = yield* EffectConfig.option(EffectConfig.String('BOLT_TEST_S3'));
			if (Option.isNone(minio)) return context.skip('BOLT_TEST_S3 is not configured');
			const [endpoint, credential] = minio.value.split('|');
			if (endpoint === undefined || credential === undefined)
				throw new Error('BOLT_TEST_S3 needs <url>|<access key>:<secret>');
			const s3 = yield* s3Files(endpoint, credential).pipe(Effect.provide(FetchHttpClient.layer));
			const blob = yield* s3.put(new TextEncoder().encode('minio'), {
				name: 'm.txt',
				mime: 'text/plain'
			});
			expect(new TextDecoder().decode(yield* s3.get(blob.key, 100))).toBe('minio');
			const downloadUrl = yield* s3.url(blob.key, 60);
			expect(
				yield* Effect.tryPromise({
					try: () => fetch(downloadUrl).then((response) => response.text()),
					catch: (error) => new FacilityFailure({ kind: 'upstream', message: String(error) })
				})
			).toBe('minio');
			yield* s3.remove(blob.key);
			expect(yield* Effect.flip(s3.get(blob.key, 100))).toMatchObject({
				message: expect.stringMatching(/404/)
			});
		})
	);
});

describe('the Postgres URL (§5.11.6)', () => {
	it('requires TLS unless the URL names an sslmode', () => {
		expect(pgOptions('postgres://u:p@db.example/app')).toMatchObject({ ssl: true });
		expect(pgOptions('postgres://u:p@127.0.0.1/app?sslmode=disable')).not.toHaveProperty('ssl');
	});
});

describe('activation requirements (rule 69)', () => {
	const config = (over: { [k: string]: string } = {}) =>
		configured({
			BOLT_ARTIFACT: '/a',
			BOLT_PGLITE_DIR: '/d',
			BOLT_AUDIT_DIR: '/audit',
			BOLT_PUBLIC_URL: 'http://localhost:3100',
			BOLT_FILES_PROVIDER: 'local',
			BOLT_FILES_ENDPOINT: '/f',
			...over
		});
	const manifest = (over: Record<string, unknown> = {}) =>
		Schema.decodeUnknownSync(EngineManifestSchema)({
			models: {},
			relationships: {},
			exposures: {},
			integrations: {},
			pipelines: {},
			policies: {},
			teams: {},
			automations: {},
			connections: {},
			envoys: {},
			mcp: {},
			apps: {},
			customFields: {},
			...over,
			workspace: {
				tz: 'UTC',
				locale: 'en',
				...(Predicate.isObject(over['workspace']) ? over['workspace'] : {})
			},
			agent: { skills: {}, ...(Predicate.isObject(over['agent']) ? over['agent'] : {}) }
		});
	const errors = (c: Config, m: EngineManifest, dev = false) =>
		requirements(dev ? { ...c, mode: 'dev' } : c, m, {}).errors.join('\n');

	it.effect(
		'reads speech (BOLT_AI_SPEECH_*) as its own optional facility with a model per capability',
		() =>
			Effect.gen(function* () {
				expect((yield* config()).speech).toBeNull();
				const on = { BOLT_AI_SPEECH_PROVIDER: 'openrouter', BOLT_AI_SPEECH_CREDENTIAL: 'k' };
				expect(
					(yield* config({ ...on, BOLT_AI_TRANSCRIBE_MODEL: 'google/gemini-3.5-flash' })).speech
				).toEqual({
					endpoint: 'https://openrouter.ai/api/v1',
					credential: 'k',
					transcribe: 'google/gemini-3.5-flash',
					speak: null,
					voice: null
				});
				expect(
					(yield* config({
						...on,
						BOLT_AI_SPEECH_ENDPOINT: 'https://or.test/v1',
						BOLT_AI_SPEAK_MODEL: 'tts',
						BOLT_AI_SPEAK_VOICE: 'Kore'
					})).speech
				).toMatchObject({
					endpoint: 'https://or.test/v1',
					transcribe: null,
					speak: 'tts',
					voice: 'Kore'
				});
				expect(yield* Effect.flip(config({ ...on }))).toMatchObject({
					message: expect.stringMatching(/BOLT_AI_TRANSCRIBE_MODEL or BOLT_AI_SPEAK_MODEL/)
				});
				expect(
					yield* Effect.flip(
						config({ BOLT_AI_SPEECH_PROVIDER: 'openrouter', BOLT_AI_TRANSCRIBE_MODEL: 'm' })
					)
				).toMatchObject({ message: expect.stringMatching(/BOLT_AI_SPEECH_CREDENTIAL/) });
				expect(yield* Effect.flip(config({ BOLT_AI_TRANSCRIBE_MODEL: 'm' }))).toMatchObject({
					message: expect.stringMatching(/BOLT_AI_SPEECH_PROVIDER/)
				});
				expect(
					yield* Effect.flip(
						config({ ...on, BOLT_AI_SPEECH_PROVIDER: 'acme', BOLT_AI_TRANSCRIBE_MODEL: 'm' })
					)
				).toMatchObject({ message: expect.stringMatching(/not registered/) });
			})
	);

	it.effect('--dev / BOLT_DEV runs only on a loopback origin outside production (L-BOLT-366)', () =>
		Effect.gen(function* () {
			expect((yield* config()).mode).toBe('local');
			expect((yield* config({ BOLT_DEV: '1' })).mode).toBe('dev');
			expect(
				(yield* configured(
					{
						BOLT_ARTIFACT: '/a',
						BOLT_PGLITE_DIR: '/d',
						BOLT_AUDIT_DIR: '/audit',
						BOLT_PUBLIC_URL: 'http://localhost:3100'
					},
					{ dev: true }
				)).mode
			).toBe('dev');
			expect(yield* Effect.flip(config({ BOLT_DEV: 'yes' }))).toMatchObject({
				message: expect.stringMatching(/BOLT_DEV/)
			});
			expect(
				yield* Effect.flip(config({ BOLT_DEV: '1', BOLT_ENVIRONMENT: 'production' }))
			).toMatchObject({ message: expect.stringMatching(/production/) });
			expect(
				yield* Effect.flip(config({ BOLT_DEV: '1', BOLT_PUBLIC_URL: 'https://acme.example' }))
			).toMatchObject({ message: expect.stringMatching(/loopback/) });
		})
	);

	it.effect(
		'needs the master key for declared secrets, Turnstile for a challenged app, a model for every declared class',
		() =>
			Effect.gen(function* () {
				expect(errors(yield* config(), manifest())).toBe('');
				expect(
					errors(
						yield* config(),
						manifest({
							workspace: { tz: 'UTC', secrets: { API_KEY: { label: 'API key' } } }
						})
					)
				).toMatch(/BOLT_MASTER_KEY/);
				// an instance pairs only with the master key to seal its credentials: without it the host warns, and starts
				const instances = requirements(
					yield* config(),
					manifest({ connections: { mail: { integration: 'email' } } }),
					{}
				);
				expect([instances.errors, instances.warnings.join('\n')]).toEqual([
					[],
					expect.stringMatching(/declares integrations but BOLT_MASTER_KEY is not set/)
				]);
				const challenged = manifest({ apps: { kiosk: { audience: { challenge: 'turnstile' } } } });
				expect(errors(yield* config(), challenged)).toMatch(/BOLT_TURNSTILE/);
				expect(errors(yield* config(), challenged, true)).toBe(''); // bolt dev's dev Turnstile
				const ai = manifest({
					workspace: { tz: 'UTC', ai: { models: ['default', 'fast'], default: 'default' } }
				});
				const both = {
					BOLT_AI_SYS_1_PROVIDER: 'openai',
					BOLT_AI_SYS_1_MODEL: 't',
					BOLT_AI_SYS_2_PROVIDER: 'openai'
				};
				expect(
					errors(yield* config({ ...both, BOLT_AI_SYS_2_MODELS: '{"default":"gpt"}' }), ai)
				).toMatch(/BOLT_AI_SYS_2_MODELS maps no model to fast/);
				// the AI facility is sys_1 and sys_2 together (P35): one without the other refuses to start
				expect(
					yield* Effect.flip(
						config({
							BOLT_AI_SYS_2_PROVIDER: 'openai',
							BOLT_AI_SYS_2_MODELS: '{"default":"gpt","fast":"g"}'
						})
					)
				).toMatchObject({ message: expect.stringMatching(/BOLT_AI_SYS_1_PROVIDER/) });
				expect(
					errors(
						yield* config({ ...both, BOLT_AI_SYS_2_MODELS: '{"default":"gpt","fast":"g"}' }),
						ai
					)
				).toBe('');
				// sys_1 on the Decisions API names its URL and key
				expect(
					yield* Effect.flip(config({ ...both, BOLT_AI_SYS_1_PROVIDER: 'decisions' }))
				).toMatchObject({ message: expect.stringMatching(/BOLT_AI_SYS_1_ENDPOINT/) });
				expect(
					yield* config({
						...both,
						BOLT_AI_SYS_1_PROVIDER: 'decisions',
						BOLT_AI_SYS_1_ENDPOINT: 'https://d.test',
						BOLT_AI_SYS_1_CREDENTIAL: 'k'
					})
				).toBeDefined();
				expect(requirements(yield* config(), ai, {}).warnings.join('\n')).toMatch(
					/AI is not configured.*without triage and the AI filter is hidden/
				);
				expect(
					requirements(
						yield* config(),
						manifest({ agent: { internal: 'You help.' } }),
						{}
					).warnings.join('\n')
				).toMatch(/AI is not configured/); // the agent needs one too
				// the engine reads files (§5.8.1): a file field warns of nothing
				expect(
					requirements(
						yield* config(),
						manifest({ models: { photos: { fields: { photo: { kind: 'file' } } } } }),
						{}
					).warnings.join('\n')
				).not.toMatch(/files\./);
				// a deployed host needs the host's messaging; a local one prints it to its log
				expect(
					errors(
						yield* configured({
							BOLT_ARTIFACT: '/a',
							BOLT_PGLITE_DIR: '/d',
							BOLT_AUDIT_DIR: '/audit',
							BOLT_PUBLIC_URL: 'https://acme.example'
						}),
						manifest()
					)
				).toMatch(/files are required[\s\S]*BOLT_TRANSACTIONAL_EMAIL/);
				expect(
					errors(
						yield* configured({
							BOLT_ARTIFACT: '/a',
							BOLT_PGLITE_DIR: '/d',
							BOLT_AUDIT_DIR: '/audit',
							BOLT_PUBLIC_URL: 'http://localhost:3100',
							BOLT_FILES_PROVIDER: 'local',
							BOLT_FILES_ENDPOINT: '/f'
						}),
						manifest()
					)
				).toBe('');
				expect(errors(yield* config({ BOLT_ENVIRONMENT: 'production' }), manifest())).toMatch(
					/BOLT_TRANSACTIONAL_EMAIL/
				);
				// phone sign-up needs a phone provider on a deployed host
				const phone = manifest({
					workspace: { tz: 'UTC', signup: { via: ['phone'], policies: [] } }
				});
				const deployed = {
					BOLT_PUBLIC_URL: 'https://acme.example',
					BOLT_TRANSACTIONAL_EMAIL: 'resend',
					BOLT_RESEND_API_KEY: 're_k'
				};
				expect(errors(yield* config(deployed), phone)).toMatch(/BOLT_TRANSACTIONAL_PHONE/);
				expect(
					errors(
						yield* config({
							...deployed,
							BOLT_TRANSACTIONAL_PHONE: 'twilio',
							BOLT_TWILIO_ACC_SID: 'AC1',
							BOLT_TWILIO_AUTH_TOKEN: 't'
						}),
						phone
					)
				).toBe('');
			})
	);

	it.effect(
		'binds ctx.convert to Norbital Convert, and warns of declared targets when it is absent',
		() =>
			Effect.gen(function* () {
				const converts = manifest({ workspace: { tz: 'UTC', convert: { to: ['pdf', 'docx'] } } });
				const warned = (c: Config) => requirements(c, converts, {}).warnings.join('\n');
				expect(warned(yield* config())).toMatch(
					/converts to pdf, docx but no converter is configured \(BOLT_CONVERT_PROVIDER=norbital\)/
				);
				expect(
					warned(
						yield* config({
							BOLT_CONVERT_PROVIDER: 'norbital',
							BOLT_CONVERT_ENDPOINT: 'http://convert:8080',
							BOLT_CONVERT_CREDENTIAL: 'k'
						})
					)
				).not.toMatch(/converts to/);
				expect(
					yield* Effect.flip(
						config({
							BOLT_CONVERT_PROVIDER: 'norbital',
							BOLT_CONVERT_ENDPOINT: 'http://convert:8080'
						})
					)
				).toMatchObject({ message: expect.stringMatching(/BOLT_CONVERT_CREDENTIAL, its API key/) });
				expect(
					yield* Effect.flip(
						config({
							BOLT_CONVERT_PROVIDER: 'pandoc',
							BOLT_CONVERT_ENDPOINT: 'http://x',
							BOLT_CONVERT_CREDENTIAL: 'k'
						})
					)
				).toMatchObject({
					message: expect.stringMatching(/not registered on this host \(norbital\)/)
				});
			})
	);

	it.effect('decodes the s3 files provider and refuses it half-configured', () =>
		Effect.gen(function* () {
			expect(
				(yield* config({
					BOLT_FILES_PROVIDER: 's3',
					BOLT_FILES_ENDPOINT: 'https://r2.example/bucket',
					BOLT_FILES_CREDENTIAL: 'ak:sk'
				})).files
			).toEqual({ provider: 's3', endpoint: 'https://r2.example/bucket', credential: 'ak:sk' });
			expect(
				yield* Effect.flip(
					config({ BOLT_FILES_PROVIDER: 's3', BOLT_FILES_ENDPOINT: 'https://r2.example/bucket' })
				)
			).toMatchObject({ message: expect.stringMatching(/BOLT_FILES_CREDENTIAL/) });
		})
	);
});

describe('web reads (BOLT_WEB_PROVIDER=public)', () => {
	it.effect('answers the page as text with its title; a refused read throws', () =>
		Effect.gen(function* () {
			const ok = publicWeb(() =>
				Effect.succeed({
					url: 'https://x.example/',
					body: '<title>Hi</title><script>x()</script><p>Hello <b>world</b></p>'
				})
			);
			expect(yield* ok.read('https://x.example')).toEqual({
				url: 'https://x.example/',
				title: 'Hi',
				text: 'Hi Hello world'
			});
			const no = publicWeb(() =>
				Effect.fail(
					new FacilityFailure({
						kind: 'upstream',
						message: 'Public-page retrieval cannot reach private or reserved networks.'
					})
				)
			);
			expect(yield* Effect.flip(no.read('https://10.0.0.1'))).toMatchObject({
				message: expect.stringMatching(/private/)
			});
		})
	);

	it.live(
		'carries the content type, digest and page count, and the raw HTML with its links when asked',
		() =>
			Effect.gen(function* () {
				const page = {
					url: 'https://x.example/a/',
					contentType: 'text/html; charset=utf-8',
					sha256: 'f'.repeat(64),
					body: '<title>Hi</title><a href="b.pdf">B</a> <a href="https://y.example/c">C</a> <a href="mailto:x@y">M</a> <a href="#top">T</a>'
				};
				const web = publicWeb(() => Effect.succeed(page));
				expect(yield* web.read('https://x.example/a/')).toEqual({
					url: page.url,
					title: 'Hi',
					text: 'Hi B C M T',
					contentType: page.contentType,
					sha256: page.sha256
				});
				const raw = yield* Effect.gen(function* () {
					const facility = yield* Facilities;
					return yield* facility.dispatch({ _tag: 'web.read', args: [page.url, { raw: true }] });
				}).pipe(
					Effect.provide(
						TestWorkspace.layer({
							manifest: Schema.decodeUnknownSync(EngineManifestSchema)({
								workspace: { tz: 'UTC', locale: 'en' },
								models: {},
								relationships: {},
								exposures: {},
								integrations: {},
								pipelines: {},
								policies: {},
								teams: {},
								automations: {},
								connections: {},
								envoys: {},
								mcp: {},
								apps: {},
								customFields: {},
								agent: { skills: {} }
							}),
							ports: Layer.succeed(WebRead, web)
						})
					)
				);
				expect(raw).toMatchObject({
					ok: true,
					value: { html: page.body, links: ['https://x.example/a/b.pdf', 'https://y.example/c'] }
				});
				const pdf = publicWeb(() =>
					Effect.succeed({
						url: 'https://x.example/n.pdf',
						contentType: 'application/pdf',
						sha256: 'e'.repeat(64),
						pageCount: 3,
						body: 'Notice text'
					})
				);
				expect(yield* pdf.read('https://x.example/n.pdf', { raw: true })).toEqual({
					url: 'https://x.example/n.pdf',
					title: null,
					text: 'Notice text',
					contentType: 'application/pdf',
					sha256: 'e'.repeat(64),
					pages: 3
				});
			})
	);
});
