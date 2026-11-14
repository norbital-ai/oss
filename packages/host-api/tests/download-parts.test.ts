import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { store_media, type DownloadSink } from '../src/node/download.ts';

const MiB = 1024 * 1024;

describe('store_media multipart parts', () => {
	it.effect('every part but the last has one length, whatever the chunks arrive as', () =>
		Effect.gen(function* () {
			// a PDF arriving in uneven chunks, as a network stream does: about 18 MiB
			const sizes = [3 * MiB + 7, 2 * MiB + 1, 4 * MiB + 3, MiB, 3 * MiB + 5, 5 * MiB];
			const chunk = (i: number) => {
				const bytes = new Uint8Array(sizes[i] ?? 0).fill(i);
				if (i === 0) bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
				return bytes;
			};
			let index = 0;
			const next = Effect.sync(() => (index < 6 ? chunk(index++) : undefined));
			const parts: number[] = [];
			const sink: DownloadSink<null> = {
				begin: () => Effect.succeed(null),
				part: (_upload, bytes) => Effect.sync(() => void parts.push(bytes.byteLength)),
				complete: () => Effect.succeed('key'),
				abort: () => Effect.void
			};
			yield* store_media('a.pdf', next, sink);
			const total = sizes.reduce((a, b) => a + b, 0);
			expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
			expect(new Set(parts.slice(0, -1)).size).toBe(1);
			expect(parts.at(-1)).toBeLessThanOrEqual(parts[0] ?? 0);
		})
	);
});
