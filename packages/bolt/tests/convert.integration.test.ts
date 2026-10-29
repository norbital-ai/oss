// `ctx.convert.document` (optional host capability): Markdown or HTML to a target the workspace declares, over the host's
// ConvertPort, stored like `files.put`; then the converter client against a local Norbital Convert service.
import { uuidv7 } from '../src/protocol/wire.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { Convert, Files } from '../src/engine/ports.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { service } from '../../../services/convert/src/server.ts';
import { ConversionFailed } from '../../../services/convert/src/convert.ts';
import type { Json } from '../src/decl/values.ts';
import { documentConverter } from '../src/engine/convert.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en', convert: { to: ['pdf', 'docx'] } },
		models: {
			docs: {
				description: 'A document',
				label: 'title',
				fields: { title: { kind: 'text' }, file: { kind: 'file', accept: ['*/*'], max: '1MiB' } }
			}
		},
		relationships: {},
		exposures: {
			docs: { read: { docs: { fields: 'all' } }, create: { columns: { docs: ['title', 'file'] } } }
		},
		integrations: {},
		teams: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} },
		policies: {
			ops: { description: 'Ops', grants: { docs: { read: true } }, automations: ['make'] }
		},
		automations: {
			make: {
				description: 'Converts a document',
				policies: ['ops'],
				input: { options: { kind: 'json' } }
			}
		}
	})
);

const guest = program(`import { Effect } from 'effect';
export default { automation: { make: { body: function* ({ options }, ctx) {
	return yield* ctx.convert.document({ markdown: '# Report\\n\\n45 µΩ at 31 °C' }, { name: 'out', for: 'make', ...options }).pipe(Effect.catch((error) => Effect.succeed(error._tag === 'Unavailable'
		? { kind: 'unavailable', facility: error.facility, reason: error.reason }
		: { kind: error.kind, message: error.message })));
} } } };`);

type Call = Parameters<Convert['Service']['convert']>;
const fake = (targets: Convert['Service']['targets'], calls: Call[] = []): Convert['Service'] => ({
	targets,
	convert: (...args) =>
		Effect.sync(() => {
			calls.push(args);
			return new TextEncoder().encode(`converted to ${args[1]}`);
		})
});
const Output = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	name: Schema.optionalKey(Schema.String),
	mime: Schema.optionalKey(Schema.String),
	kind: Schema.optionalKey(Schema.String),
	facility: Schema.optionalKey(Schema.String),
	message: Schema.optionalKey(Schema.String),
	reason: Schema.optionalKey(Schema.String)
});
/** One workspace bound to `convert`; `make` starts one conversion run there and answers its row. */
const workspace = (convert?: Convert['Service'], reference?: Uint8Array) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				...(convert === undefined ? {} : { ports: Layer.succeed(Convert, convert) })
			})
		);
		const t = Context.get(context, TestWorkspace),
			files = Context.get(context, Files);
		const admin = t.as(t.admin),
			route = yield* routeFixture(context);
		let ref: Json | undefined;
		if (reference !== undefined) {
			const up = yield* admin.upload('docs.file', {
				name: 'letterhead.docx',
				mime: 'application/octet-stream',
				bytes: reference
			});
			if (up.kind !== 'committed') throw new Error('upload failed');
			ref = { id: up.output.id, name: up.output.name, mime: up.output.mime };
			yield* actReply(route, admin.authority, {
				callable: 'docs.create',
				input: [{ title: 'Letterhead', file: ref }],
				issuedAt: t.clock.now()
			});
		}
		const make = (options: Readonly<Record<string, Json>>, withReference = false) =>
			Effect.gen(function* () {
				const id = uuidv7(Date.parse(t.clock.now()));
				yield* actReply(route, t.as(t.member(['ops'])).authority, {
					callable: 'start',
					input: {
						automation: 'make',
						input: {
							options: {
								...options,
								...(withReference && ref !== undefined ? { reference: ref } : {})
							}
						},
						id
					},
					issuedAt: t.clock.now()
				});
				yield* t.runDue();
				const [run] = (yield* t.db.read([
					{ text: `SELECT state, output, error FROM sys_run WHERE id = $1`, params: [id] }
				]))[0]!.rows;
				if (run === undefined) throw new Error('make did not produce a run');
				return { run, output: yield* Schema.decodeUnknownEffect(Output)(run['output']) };
			});
		return { t, files, make };
	});

describe('ctx.convert.document', () => {
	it.live(
		'converts to a declared target with its reference and page options, stores the output, and refuses bad options',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const calls: Call[] = [];
					const letterhead = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
					const { t, files, make } = yield* workspace(
						fake(['pdf', 'docx', 'pptx'], calls),
						letterhead
					);
					const { run, output } = yield* make({ to: 'docx' }, true);
					expect(run).toMatchObject({ state: 'succeeded', error: null });
					expect(calls).toHaveLength(1);
					const [src, to, opts] = calls[0]!;
					expect(src).toEqual({ markdown: '# Report\n\n45 µΩ at 31 °C' });
					expect(to).toBe('docx');
					expect([...opts.reference!]).toEqual([...letterhead]);
					expect(output).toMatchObject({
						name: 'out',
						mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
					});
					const [row] = (yield* t.db.read([
						{ text: `SELECT key, field FROM sys_file WHERE id = $1`, params: [output.id!] }
					]))[0]!.rows;
					expect(row!['field']).toBe('make');
					const stored = yield* files.get(String(row!['key']), 1024);
					expect(new TextDecoder().decode(stored)).toBe('converted to docx');
					yield* make({ to: 'pdf', page: 'Letter', landscape: true });
					expect(calls[1]![2]).toEqual({ page: 'Letter', landscape: true });
					expect((yield* make({ to: 'pptx' })).output).toMatchObject({
						kind: 'invalid',
						message: expect.stringContaining("'pptx' is not declared")
					});
					expect((yield* make({ to: 'pdf', page: 'A5' })).output).toMatchObject({
						kind: 'invalid',
						message: expect.stringMatching(/A4.*A3.*Letter/)
					});
					expect((yield* make({ to: 'docx', landscape: true })).output).toMatchObject({
						kind: 'invalid',
						message: expect.stringContaining("a pdf's")
					});
					expect((yield* make({ to: 'pdf' }, true)).output).toMatchObject({
						kind: 'invalid',
						message: expect.stringContaining('takes no reference')
					});
				})
			)
	);

	it.live(
		'answers unavailable when the host binds no converter, or one that serves no such target',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					expect((yield* (yield* workspace()).make({ to: 'pdf' })).output).toMatchObject({
						kind: 'unavailable',
						facility: 'convert'
					});
					expect(
						(yield* (yield* workspace(fake(['docx']))).make({ to: 'pdf' })).output
					).toMatchObject({
						kind: 'unavailable',
						reason: expect.stringContaining('no pdf')
					});
				})
			)
	);
});

// The provider against the service itself (oss/services/convert), in process with a stand-in converter, so the wire shapes
// are the service's own.
describe('documentConverter (Norbital Convert)', () => {
	const seen: unknown[] = [];
	let url = '',
		stop = async () => {};
	beforeAll(async () => {
		const svc = service({
			keys: ['k'],
			database: join(mkdtempSync(join(tmpdir(), 'bolt-convert-')), 'jobs.db'),
			pollMs: 20,
			convert: (request, reference) =>
				Effect.suspend(() => {
					seen.push({ ...request, reference: reference && [...reference] });
					return request.source === 'fail'
						? Effect.fail(new ConversionFailed({ message: 'pandoc: unreadable input' }))
						: Effect.succeed(new TextEncoder().encode(`${request.to} bytes`));
				})
		});
		await new Promise<void>((r) => svc.server.listen(0, r));
		const address = svc.server.address();
		if (address === null || typeof address === 'string') throw new Error('no converter address');
		url = `http://localhost:${address.port}`;
		stop = svc.stop;
	});
	afterAll(() => stop());

	it.live('serves every target, submitting the job and fetching its bytes once it settles', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const port = documentConverter({ url, key: 'k' });
				expect(port.targets).toEqual(['pdf', 'docx', 'pptx', 'odt', 'epub', 'html']);
				expect(
					new TextDecoder().decode(
						yield* port
							.convert({ markdown: '# R' }, 'pdf', { page: 'A3', landscape: true })
							.pipe(Effect.timeout('10 seconds'))
					)
				).toBe('pdf bytes');
				yield* port
					.convert({ html: '<p>x</p>' }, 'docx', { reference: new Uint8Array([1, 2, 3]) })
					.pipe(Effect.timeout('10 seconds'));
				expect(seen).toEqual([
					{
						from: 'markdown',
						to: 'pdf',
						source: '# R',
						page: 'A3',
						landscape: true,
						reference: null
					},
					{ from: 'html', to: 'docx', source: '<p>x</p>', reference: [1, 2, 3] }
				]);
			})
		)
	);

	it.live(
		'resumes a stream cut after its first event, by the job id, and still returns the bytes',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let cut = 0;
					const cutting: typeof globalThis.fetch = async (input, init) => {
						const res = await fetch(input, init);
						if (
							!(input instanceof Request ? input.url : String(input)).endsWith('/v1/convert') ||
							res.body === null
						)
							return res;
						const reader = res.body.getReader();
						const first = await reader.read();
						void reader.cancel();
						cut++;
						return new Response(
							new ReadableStream({
								start(c) {
									c.enqueue(first.value);
								},
								pull(c) {
									c.error(new TypeError('terminated'));
								}
							}),
							{ status: 200 }
						);
					};
					const bytes = yield* documentConverter({ url, key: 'k', fetch: cutting })
						.convert({ markdown: '# R' }, 'epub', {})
						.pipe(Effect.timeout('10 seconds'));
					expect(cut).toBe(1);
					expect(new TextDecoder().decode(bytes)).toBe('epub bytes');
				})
			)
	);

	it.live('surfaces a failed conversion and a refused key', () =>
		Effect.scoped(
			Effect.gen(function* () {
				expect(
					(yield* Effect.flip(
						documentConverter({ url, key: 'k' })
							.convert({ markdown: 'fail' }, 'odt', {})
							.pipe(Effect.timeout('10 seconds'))
					)).message
				).toContain('pandoc: unreadable input');
				expect(
					(yield* Effect.flip(
						documentConverter({ url, key: 'wrong' })
							.convert({ markdown: 'x' }, 'odt', {})
							.pipe(Effect.timeout('10 seconds'))
					)).message
				).toMatch(/answered 401/);
			})
		)
	);
});
