// `ctx.files.image/text/table/sheet` (§5.8.1): the engine reads a stored file host-side, over real small files.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { actReply, json, routeFixture } from './support/route-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { layer, TestWorkspace, type WorkspaceServices } from '../../bolt-cli/src/test/index.ts';
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
		ops: { description: 'Ops', grants: { docs: { read: true } }, automations: ['read'] }
	},
	automations: {
		read: {
			description: 'Reads a stored file',
			policies: ['ops'],
			input: { ref: { kind: 'json' }, how: { kind: 'text' } }
		}
	},
	needs: []
} satisfies EngineManifest;

const guest = program(`import { Effect, Result } from 'effect';
export default { automation: { read: { body: function* ({ ref, how }, ctx) {
	if (how === 'jpeg') { const small = yield* ctx.files.image(ref, { jpeg: { maxEdge: 40 } }); return { small, facts: yield* ctx.files.image(small) }; }
	const result = yield* Effect.result(ctx.files[how](ref));
	return Result.isSuccess(result) ? result.success : result.failure;
} } } };`);

const bytes = (name: string) =>
	new Uint8Array(readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url)));

// One workspace for the file: each read stores its own file and reads back its own run.
const read = (name: string, mime: string, how: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const t = yield* TestWorkspace,
				route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>()),
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
				input: [{ title: name, file: up }],
				issuedAt: t.clock.now()
			});
			const id = uuidv7(Date.parse(t.clock.now()));
			yield* actReply(route, t.as(t.member(['ops'])).authority, {
				callable: 'start',
				input: { automation: 'read', input: { ref: up, how }, id },
				issuedAt: t.clock.now()
			});
			yield* t.runDue();
			const [run] = yield* t.db.rows(
				Schema.Struct({ state: Schema.String, output: Schema.Json, error: Schema.Json }),
				{ text: 'SELECT state, output, error FROM sys_run WHERE id = $1', params: [id] }
			);
			expect(run).toMatchObject({ state: 'succeeded', error: null });
			if (run === undefined) throw new Error('Missing file read run');
			return run.output;
		})
	);
const Pdq = Schema.Struct({ pdq: Schema.String });

/** The suite's workspace runs on the real clock, as `it.live` would. */
const LIVE = { excludeTestServices: true };
layer(Layer.unwrap(Effect.map(guest, (g) => TestWorkspace.layer({ manifest, guest: g }))), LIVE)(
	'ctx.files',
	(it) => {
		it.effect(
			'image: JPEG facts and EXIF, PNG, HEIC near its JPEG, a derived JPEG, a non-image refused',
			() =>
				Effect.gen(function* () {
					const jpeg = yield* read('photo.jpg', 'image/jpeg', 'image');
					expect(jpeg).toEqual({
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
					expect(yield* read('photo.png', 'image/png', 'image')).toMatchObject({
						format: 'png',
						width: 32,
						height: 24,
						exif: {}
					});
					const heic = yield* read('photo.heic', 'image/heic', 'image');
					expect(heic).toMatchObject({ format: 'heic', width: 80, height: 60 });
					const bits = (h: string) =>
						[...h].map((d) => parseInt(d, 16).toString(2).padStart(4, '0')).join('');
					const a = bits((yield* Schema.decodeUnknownEffect(Pdq)(heic)).pdq),
						b = bits((yield* Schema.decodeUnknownEffect(Pdq)(jpeg)).pdq);
					expect([...a].filter((x, i) => x !== b[i]).length).toBeLessThanOrEqual(31); // PDQ's near-duplicate threshold
					const out = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ small: Schema.Json, facts: Schema.Json })
					)(yield* read('photo.heic', 'image/heic', 'jpeg'));
					expect(out.small).toMatchObject({ name: 'photo.jpg', mime: 'image/jpeg' });
					expect(out.facts).toMatchObject({ format: 'jpeg', width: 40, height: 30 });
					expect(yield* read('items.csv', 'text/csv', 'image')).toMatchObject({
						kind: 'upstream',
						message: expect.stringContaining('JPEG, PNG and HEIC')
					});
				})
		);

		it.effect('text as UTF-8, CSV and xlsx as tables, xlsx as typed sheets', () =>
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
	}
);
