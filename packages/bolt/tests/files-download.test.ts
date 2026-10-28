// A local host's `download` (P21): media by its first bytes streams into the store under its sha256; a refusal, a body
// past the cap, a stall, a private redirect or a long chain leaves nothing behind.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { FacilityFailure } from '../src/decl/errors.ts';
import { mediaType } from '../src/engine/files/media.ts';
import { localFiles } from '../src/node/files.ts';

const MiB = 1024 * 1024;
const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(5000, 7)
]);
const mp4 = Buffer.concat([
	Buffer.from([0, 0, 0, 0x18]),
	Buffer.from('ftypisom'),
	Buffer.alloc(11 * MiB, 1)
]);
const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), Buffer.alloc(5000)]);
const page = Buffer.from('<!DOCTYPE html><html><body>Public record</body></html>');

const routes: Record<string, (res: ServerResponse) => void> = {
	'/photo': (res) =>
		res
			.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-disposition': `attachment; filename*=UTF-8''seal%20of%20office.png`
			})
			.end(png),
	'/clip.mp4': (res) => res.writeHead(200, { 'content-type': 'video/mp4' }).end(mp4),
	'/page': (res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page),
	'/to-clip': (res) => res.writeHead(302, { location: '/clip.mp4' }).end(),
	'/elf-as-png': (res) => res.writeHead(200, { 'content-type': 'image/png' }).end(elf),
	// a host's stub where its PDF was (lom.agc.gov.my serves `false` under application/pdf)
	'/stub.pdf': (res) => res.writeHead(200, { 'content-type': 'application/pdf' }).end('false'),
	'/to-metadata': (res) =>
		res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end(),
	'/stall': (res) => {
		res.writeHead(200, { 'content-type': 'video/mp4' });
		res.write(mp4.subarray(0, 8192));
	}
};
const origin = Effect.acquireRelease(
	Effect.callback<{ server: ReturnType<typeof createServer>; base: string }, FacilityFailure>(
		(resume) => {
			const server = createServer((req, res) => {
				const path = new URL(req.url ?? '/', 'http://x').pathname,
					loop = /^\/loop(\d+)$/.exec(path);
				if (loop !== null) res.writeHead(302, { location: `/loop${Number(loop[1]) + 1}` }).end();
				else (routes[path] ?? ((r: ServerResponse) => r.writeHead(404).end()))(res);
			});
			server.once('error', (error) =>
				resume(Effect.fail(new FacilityFailure({ kind: 'upstream', message: error.message })))
			);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				resume(
					Effect.succeed({
						server,
						base: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
					})
				);
			});
		}
	),
	({ server }) =>
		Effect.sync(() => {
			server.closeAllConnections();
			server.close();
		})
);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('localFiles download', () => {
	it.live('streams media into the store by its bytes, through a redirect and in parts', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { base } = yield* origin,
					dir = mkdtempSync(join(tmpdir(), 'bolt-download-'));
				const files = localFiles(dir, { allowLoopback: true });
				const photo = yield* files.download(`${base}/photo`);
				expect(photo).toEqual({
					key: sha(png),
					bytes: png.byteLength,
					sha256: sha(png),
					mime: 'image/png',
					name: 'seal of office.png'
				});
				const clip = yield* files.download(`${base}/to-clip`);
				expect(clip).toMatchObject({ mime: 'video/mp4', name: 'clip.mp4', bytes: mp4.byteLength });
				expect(sha(readFileSync(join(dir, clip.key)))).toBe(sha(mp4));
				const document = yield* files.download(`${base}/page`);
				expect(document).toMatchObject({ mime: 'text/html', bytes: page.byteLength });
				expect(readFileSync(join(dir, document.key))).toEqual(page);
				expect(readdirSync(dir).sort()).toEqual([sha(png), sha(mp4), sha(page)].sort());
			})
		)
	);

	it.live(
		'refuses what is not media, a failed status, a private hop, a long chain, a cap and a stall',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { base } = yield* origin,
						dir = mkdtempSync(join(tmpdir(), 'bolt-download-'));
					const files = localFiles(dir, { allowLoopback: true });
					const refused = (url: string, f = files) => Effect.flip(f.download(url));
					expect(yield* refused(`${base}/elf-as-png`)).toMatchObject({
						kind: 'invalid',
						message: expect.stringMatching(
							/not media.*: it is (at least )?\d+ bytes, beginning "\.ELF/
						)
					});
					expect(yield* refused(`${base}/stub.pdf`)).toMatchObject({
						kind: 'invalid',
						message:
							'The file is not media (an image, audio, video, a PDF or an HTML page): it is 5 bytes, beginning "false"; nothing was stored.'
					});
					expect(yield* refused(`${base}/missing`)).toMatchObject({
						kind: 'upstream',
						status: 404
					});
					expect(yield* refused(`${base}/to-metadata`)).toMatchObject({ kind: 'invalid' });
					expect(yield* refused(`${base}/loop0`)).toMatchObject({
						kind: 'invalid',
						message: expect.stringMatching(/more than 5/)
					});
					expect(yield* refused('ftp://law.example/a.png')).toMatchObject({ kind: 'invalid' });
					expect(
						yield* refused(
							`${base}/clip.mp4`,
							localFiles(dir, { allowLoopback: true, maxBytes: MiB })
						)
					).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/over/) });
					expect(
						yield* refused(`${base}/stall`, localFiles(dir, { allowLoopback: true, idleMs: 200 }))
					).toMatchObject({ kind: 'timeout' });
					// without the development flag, this machine is a private network
					expect(yield* refused(`${base}/photo`, localFiles(dir))).toMatchObject({
						kind: 'invalid'
					});
					expect(readdirSync(dir)).toEqual([]);
				})
			)
	);
});

describe('the media rule', () => {
	it('reads the type from the bytes, never from a name or header', () => {
		expect(mediaType(png)).toBe('image/png');
		expect(mediaType(mp4)).toBe('video/mp4');
		expect(mediaType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
		expect(mediaType(page)).toBe('text/html');
		expect(mediaType(Buffer.from('  <!doctype HTML>\n<html></html>'))).toBe('text/html');
		expect(mediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
		expect(mediaType(Buffer.from('ID3\x04'))).toBe('audio/mpeg');
		// CAD models and drawings, each by its own signature
		expect(mediaType(Buffer.from('ISO-10303-21;\nHEADER;'))).toBe('model/step');
		expect(mediaType(Buffer.from('AC1032\0\0'))).toBe('image/vnd.dwg');
		expect(mediaType(Buffer.from('  0\r\nSECTION\r\n  2\r\nHEADER'))).toBe('image/vnd.dxf');
		expect(mediaType(Buffer.from('solid bracket\n  facet normal 0 0 1'))).toBe('model/stl');
		expect(mediaType(Buffer.from(`${'Bracket model'.padEnd(72)}S      1\n`))).toBe('model/iges');
		expect(mediaType(Buffer.from('glTF\x02\0\0\0'))).toBe('model/gltf-binary');
		expect(mediaType(Buffer.from('II*\0\x08\0'))).toBe('image/tiff');
		for (const other of [
			elf,
			Buffer.from('MZ\x90\x00'),
			Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
			Buffer.from('export const answer = 42;\n'),
			Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
			Buffer.from('PK\x03\x04'),
			Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
			Buffer.from('solid state of the art\nmore prose'),
			Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
			new Uint8Array()
		])
			expect(mediaType(other)).toBeUndefined();
	});
});
