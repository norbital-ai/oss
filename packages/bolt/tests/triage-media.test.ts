import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { triageAttachments } from '../src/engine/agent/attachments.ts';
import { Files, Images, Logs } from '../src/engine/ports.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '@norbital-ai/host-api';
import { images_port } from '@norbital-ai/host-api/node';

const fixture = (name: string, mime: string, bytes: Uint8Array) => {
	const row = { id: 'f', name, mime, size: bytes.length, key: 'original', sha256: 'a'.repeat(64) };
	let reads = 0;
	const db = TenantDb.typed({
		read: (queries) => Effect.succeed(queries.map(() => ({ rows: [row], affected: 0 }))),
		write: () => Effect.die('triage writes nothing'),
		transaction: () => Effect.die('unused transaction')
	});
	const files = Files.of({
		get: () =>
			Effect.sync(() => {
				reads++;
				return bytes;
			}),
		put: () => Effect.die('unused put'),
		url: () => Effect.die('unused url'),
		remove: () => Effect.die('unused remove'),
		download: () => Effect.die('unused download')
	});
	const logs = Logs.of({ write: () => Effect.void, query: () => Effect.succeed([]) });
	return { db, files, logs, reads: () => reads };
};
const images = Effect.map(Layer.build(Images.fromAbi(images_port)), (c) => Context.get(c, Images));
const context = { now: '2026-10-30T00:00:00.000Z', conversation: 'conversation' };
const messages = [{ id: 'm0', files: [{ id: 'f' }] }];
describe('triage media evidence', () => {
	it.live('shows an image, as a JPEG beside its metadata', () =>
		Effect.gen(function* () {
			const f = fixture(
				'pump.png',
				'image/png',
				new Uint8Array(readFileSync(new URL('./fixtures/files/photo.png', import.meta.url)))
			);
			const got = (yield* triageAttachments(
				f.db,
				{ ...f, images: yield* images },
				messages,
				context
			)).get('m0');
			expect(got?.unread).toBe(false);
			expect(got?.attachments).toEqual([
				expect.objectContaining({ name: 'pump.png', mime: 'image/png', image: 'message-m0-image-1' })
			]);
			expect(JSON.stringify(got?.parts)).toContain('data:image/jpeg;base64,');
		})
	);
	for (const [name, mime] of [
		['work order.pdf', 'application/pdf'],
		['voice note.ogg', 'audio/ogg'],
		['site photos.zip', 'application/zip'],
		['notes.txt', 'text/plain']
	] as const)
		it.live(`lists ${mime} by its metadata and reads none of it`, () =>
			Effect.gen(function* () {
				const f = fixture(name, mime, new Uint8Array([1, 2, 3]));
				const got = (yield* triageAttachments(
					f.db,
					{ ...f, images: yield* images },
					messages,
					context
				)).get('m0');
				expect(got?.attachments).toEqual([{ name, mime, size: 3 }]);
				expect(got?.parts).toEqual([]);
				expect(got?.unread).toBe(false);
				expect(f.reads()).toBe(0);
			})
		);
	it.live('an image past its budget leaves its metadata and stays unread', () =>
		Effect.gen(function* () {
			const f = fixture('huge.png', 'image/png', new Uint8Array(9 * 1024 * 1024));
			const got = (yield* triageAttachments(
				f.db,
				{ ...f, images: yield* images },
				messages,
				context
			)).get('m0');
			expect(got?.attachments).toEqual([
				expect.objectContaining({ name: 'huge.png', unread: true })
			]);
			expect(got?.unread).toBe(true);
		})
	);
});
