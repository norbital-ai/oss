// `ctx.files.image/text/table/sheet` (§5.8.1): the engine reads a stored file host-side, over real small files.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { program } from './support/guest-fixture.ts';
import { actReply, json, routeFixture } from './support/route-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { uuidv7 } from '../src/protocol/wire.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		docs: {
			description: 'A document',
			label: 'title',
			fields: { title: { kind: 'text' }, file: { kind: 'file', accept: ['*/*'], max: '1MiB' } }
		}
	},
	relationships: {},
	collections: {
		docs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'file'] } } }
	},
	integrations: {},
	pipelines: {},
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	policies: {
		ops: { description: 'Ops', grants: { docs: { read: true } }, automations: ['read'] }
	},
	automations: {
		read: {
			description: 'Reads a stored file',
			runAs: ['ops'],
			input: { ref: { kind: 'json' }, how: { kind: 'text' } }
		}
	}
} satisfies EngineManifest;

const guest = program(`import { Effect, Result } from 'effect';
export default { automation: { read: { body: function* ({ ref, how }, ctx) {
	if (how === 'jpeg') { const small = yield* ctx.files.image(ref, { jpeg: { maxEdge: 40 } }); return { small, facts: yield* ctx.files.image(small) }; }
	const result = yield* Effect.result(ctx.files[how](ref));
	return Result.isSuccess(result) ? result.success : result.failure;
} } } };`);

const bytes = (name: string) =>
	new Uint8Array(readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url)));

const read = (name: string, mime: string, how: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
			const t = Context.get(context, TestWorkspace),
				route = yield* routeFixture(context),
				admin = t.as(t.admin).authority;
			const up = yield* Schema.decodeUnknownEffect(
				Schema.Struct({
					id: Schema.String,
					name: Schema.String,
					mime: Schema.String,
					bytes: Schema.Number,
					sha256: Schema.String
				})
			)(
				yield* json(
					yield* route.handle(
						admin,
						new Request('http://cell/__bolt/files/docs.file', {
							method: 'PUT',
							headers: {
								'content-type': mime,
								'Idempotency-Key': randomUUID(),
								'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
							},
							body: bytes(name)
						})
					)
				)
			);
			yield* actReply(route, admin, {
				callable: 'docs.create',
				input: { title: name, file: up },
				issuedAt: t.clock.now()
			});
			yield* actReply(route, t.as(t.member(['ops'])).authority, {
				callable: 'start',
				input: {
					automation: 'read',
					input: { ref: up, how },
					id: uuidv7(Date.parse(t.clock.now()))
				},
				issuedAt: t.clock.now()
			});
			yield* t.runDue();
			const runs = yield* t.db.rows(
				Schema.Struct({ state: Schema.String, output: Schema.Json, error: Schema.Json }),
				{ text: 'SELECT state, output, error FROM sys_run', params: [] }
			);
			const run = runs[0];
			expect(run).toMatchObject({ state: 'succeeded', error: null });
			if (run === undefined) throw new Error('Missing file read run');
			return run.output;
		})
	);

describe('ctx.files.image', () => {
	it.live('reads a JPEG: size, SHA-256, PDQ and EXIF (taken, GPS, software, camera)', () =>
		Effect.gen(function* () {
			expect(yield* read('photo.jpg', 'image/jpeg', 'image')).toEqual({
				format: 'jpeg',
				width: 80,
				height: 60,
				sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
				pdq: expect.stringMatching(/^[0-9a-f]{64}$/),
				exif: {
					takenAt: expect.stringMatching(/^2026-07-0[34]T/),
					gps: { lat: expect.closeTo(1.2917, 3), lng: expect.closeTo(103.85, 3) },
					software: 'Adobe Photoshop 25.0',
					make: 'Acme',
					model: 'Cam 1'
				}
			});
		})
	);

	it.live('reads a PNG and a HEIC, the HEIC with the same picture as its JPEG', () =>
		Effect.gen(function* () {
			expect(yield* read('photo.png', 'image/png', 'image')).toMatchObject({
				format: 'png',
				width: 32,
				height: 24,
				exif: {}
			});
			const heic = yield* read('photo.heic', 'image/heic', 'image');
			const heicPdq = (yield* Schema.decodeUnknownEffect(Schema.Struct({ pdq: Schema.String }))(
				heic
			)).pdq;
			expect(heic).toMatchObject({ format: 'heic', width: 80, height: 60 });
			const jpeg = yield* read('photo.jpg', 'image/jpeg', 'image');
			const jpegPdq = (yield* Schema.decodeUnknownEffect(Schema.Struct({ pdq: Schema.String }))(
				jpeg
			)).pdq;
			const bits = (h: string) =>
				[...h].map((d) => parseInt(d, 16).toString(2).padStart(4, '0')).join('');
			const distance = [...bits(heicPdq)].filter((b, i) => b !== bits(jpegPdq)[i]).length;
			expect(distance).toBeLessThanOrEqual(31); // a near-duplicate by PDQ's own threshold
		})
	);

	it.live('derives a JPEG within maxEdge, stored on the run', () =>
		Effect.gen(function* () {
			const out = yield* Schema.decodeUnknownEffect(
				Schema.Struct({ small: Schema.Json, facts: Schema.Json })
			)(yield* read('photo.heic', 'image/heic', 'jpeg'));
			expect(out.small).toMatchObject({ name: 'photo.jpg', mime: 'image/jpeg' });
			expect(out.facts).toMatchObject({ format: 'jpeg', width: 40, height: 30 });
		})
	);

	it.live('refuses a file that is no image', () =>
		Effect.gen(function* () {
			expect(yield* read('items.csv', 'text/csv', 'image')).toMatchObject({
				kind: 'upstream',
				message: expect.stringContaining('JPEG, PNG and HEIC')
			});
		})
	);
});

describe('ctx.files.text, table, sheet', () => {
	it.live('reads text as UTF-8 and CSV as rows', () =>
		Effect.gen(function* () {
			expect(yield* read('items.csv', 'text/csv', 'text')).toBe(
				'name,qty\r\n"Bolt, M8",4\r\n"say ""hi""",2\r\n'
			);
			expect(yield* read('items.csv', 'text/csv', 'table')).toEqual([
				['name', 'qty'],
				['Bolt, M8', '4'],
				['say "hi"', '2']
			]);
			expect(yield* read('photo.png', 'image/png', 'text')).toMatchObject({ kind: 'invalid' });
		})
	);

	it.live(
		'reads an xlsx as a table of strings (its first worksheet) and as typed sheets, each by its worksheet name',
		() =>
			Effect.gen(function* () {
				const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
				expect(yield* read('items.xlsx', xlsx, 'table')).toEqual([
					['name', 'qty', 'ok'],
					['Bolt, M8', '4', 'true'],
					['Nut', '2.5', 'false']
				]);
				expect(yield* read('items.xlsx', xlsx, 'sheet')).toEqual([
					{
						name: 'Stock',
						rows: [
							['name', 'qty', 'ok'],
							['Bolt, M8', 4, true],
							['Nut', 2.5, false]
						]
					}
				]);
			})
	);
});
