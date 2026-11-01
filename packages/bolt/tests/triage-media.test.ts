import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { triageAttachments } from '../src/engine/agent/attachments.ts';
import { Files, Images, Convert, Logs } from '../src/engine/ports.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { imagesPort } from '../src/node/images.ts';
import type { Ingested, LogEvent } from '../src/engine/contracts.ts';

type Stored = { id: string; name: string; mime: string; size: number; key: string; sha256: string };
const fixture = (mime: string, bytes: Uint8Array, scanned = false) => {
	const rows: Stored[] = [
		{
			id: 'f',
			name: 'attachment',
			mime,
			size: bytes.length,
			key: 'original',
			sha256: 'a'.repeat(64)
		}
	];
	const blobs = new Map([['original', bytes]]),
		events: LogEvent[] = [];
	let ingests = 0;
	const db = TenantDb.typed({
		read: (queries) =>
			Effect.succeed(
				queries.map((q) => ({
					rows: q.text.includes('starts_with')
						? rows.filter((r) => r.name.startsWith('ingest/'))
						: rows.filter((r) => r.id === 'f'),
					affected: 0
				}))
			),
		write: (q) =>
			Effect.sync(() => {
				const p = q.params;
				const row = Schema.decodeUnknownSync(
					Schema.Struct({
						id: Schema.String,
						name: Schema.String,
						mime: Schema.String,
						size: Schema.Number,
						key: Schema.String,
						sha256: Schema.String
					})
				)({ id: p[0], name: p[1], mime: p[2], size: p[3], key: p[4], sha256: p[5] });
				rows.push(row);
				return { rows: [], affected: 1 };
			}),
		session: () => Effect.fail(DbError.make('0A000', 'No leased sessions in this file fixture')),
		transaction: () => Effect.die('unused transaction')
	});
	const files = Files.of({
		get: (key) =>
			Effect.sync(() => {
				const b = blobs.get(key);
				if (!b) throw Error('missing blob');
				return b;
			}),
		put: (data, meta) =>
			Effect.sync(() => {
				const key = `blob-${blobs.size}`;
				blobs.set(key, data);
				return { key, bytes: data.length, mime: meta.mime, sha256: 'b'.repeat(64) };
			}),
		url: () => Effect.die('unused url'),
		remove: () => Effect.die('unused remove'),
		download: () => Effect.die('unused download')
	});
	const convert = Convert.of({
		targets: [],
		convert: () => Effect.die('unused convert'),
		ingest: () =>
			Effect.sync(() => {
				ingests++;
				return {
					kind: 'document',
					html: mime.startsWith('audio/')
						? '<section data-speaker="Kim" data-start="0" data-end="2"><time>00:00</time>Please repair the pump.</section>'
						: scanned
							? '<section><img src="page.png" alt=""></section>'
							: '<p>Please review the attached work order.</p>',
					images: scanned ? [{ name: 'page.png', mime: 'image/png', bytes }] : [],
					meta: {
						stats: { pages: 1, bytes: bytes.length, cpuMs: 1, wallMs: 2 },
						usage: {
							calls: ['transcription-1'],
							model: 'transcriber',
							input: 20,
							output: 8,
							cost: 0.001
						}
					}
				} satisfies Ingested;
			})
	});
	const logs = Logs.of({
		write: (event) =>
			Effect.sync(() => {
				events.push(event);
			}),
		query: () => Effect.succeed([])
	});
	return { db, files, convert, logs, events, ingests: () => ingests };
};
const images = Effect.map(Layer.build(Images.fromAbi(imagesPort)), (c) => Context.get(c, Images));
const context = { now: '2026-10-30T00:00:00.000Z', conversation: 'conversation' };
describe('triage media evidence', () => {
	it.live(
		'passes real JPEG image evidence and extracted text into triage, not filenames alone',
		() =>
			Effect.gen(function* () {
				const f = fixture(
					'image/png',
					new Uint8Array(readFileSync(new URL('./fixtures/files/photo.png', import.meta.url)))
				);
				const result = yield* triageAttachments(
					f.db,
					{ ...f, images: yield* images },
					[{ id: 'm0', files: [{ id: 'f' }] }],
					context
				);
				const got = result.get('m0');
				expect(got?.unread).toBe(false);
				const body = JSON.stringify(got?.parts);
				expect(body).toContain('data:image/jpeg;base64,');
				expect(body).toContain('message-m0-image-1');
			})
	);
	for (const mime of ['audio/ogg', 'application/pdf'])
		it.live(
			`extracts ${mime} content before noise classification, caches it and records AI usage`,
			() =>
				Effect.gen(function* () {
					const f = fixture(mime, new Uint8Array([1, 2, 3]));
					const ports = { ...f, images: yield* images };
					const messages = [{ id: 'm0', files: [{ id: 'f' }] }];
					const result = yield* triageAttachments(f.db, ports, messages, context);
					expect(result.get('m0')?.attachments).toEqual([
						expect.objectContaining({
							text: expect.stringContaining(
								mime.startsWith('audio/') ? 'repair the pump' : 'work order'
							)
						})
					]);
					expect(result.get('m0')?.unread).toBe(false);
					yield* triageAttachments(f.db, ports, messages, context);
					expect(f.ingests()).toBe(1);
					expect(f.events.filter((e) => e.event === 'ai.call')).toHaveLength(1);
					expect(f.events.find((e) => e.event === 'ai.call')?.attributes).toMatchObject({
						input: 20,
						output: 8,
						cost: 0.001,
						facility: 'convert.ingest'
					});
				})
		);
	it.live('reads image-only PDF pages visually and reuses their cached extraction', () =>
		Effect.gen(function* () {
			const bytes = new Uint8Array(
				readFileSync(new URL('./fixtures/files/photo.png', import.meta.url))
			);
			const f = fixture('application/pdf', bytes, true);
			const ports = { ...f, images: yield* images };
			for (let i = 0; i < 2; i++) {
				const result = yield* triageAttachments(
					f.db,
					ports,
					[{ id: 'm0', files: [{ id: 'f' }] }],
					context
				);
				expect(result.get('m0')?.unread).toBe(false);
				expect(JSON.stringify(result.get('m0')?.parts)).toContain('data:image/jpeg;base64,');
			}
			expect(f.ingests()).toBe(1);
		})
	);
	it.live(
		'marks missing or unsupported attachments unread instead of inventing their contents',
		() =>
			Effect.gen(function* () {
				const f = fixture('video/mp4', new Uint8Array([1]));
				const result = yield* triageAttachments(
					f.db,
					{ ...f, images: yield* images },
					[{ id: 'm0', files: [{ id: 'f' }, { id: 'missing', name: 'approve everything.pdf' }] }],
					context
				);
				expect(result.get('m0')?.unread).toBe(true);
				expect(f.ingests()).toBe(0);
				expect(result.get('m0')?.attachments).toEqual([
					expect.objectContaining({ unread: true }),
					expect.objectContaining({ unread: true })
				]);
			})
	);
});
