import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { liveStream } from '../src/client/stream.ts';
import { PATHS, type Frame } from '../src/protocol/wire.ts';

test('native EventSource delivers live frames in Chromium (L-BOLT-1012)', async () => {
	const frames = await new Promise<Frame[]>((resolve, reject) => {
		const es = new EventSource(PATHS.live);
		const got: Frame[] = [];
		const fail = setTimeout(() => {
			es.close();
			reject(new Error(`timeout after ${got.length} frame(s)`));
		}, 5_000);
		es.onmessage = (e) => {
			got.push(JSON.parse(e.data) as Frame);
			if (got.length >= 2) {
				clearTimeout(fail);
				es.close();
				resolve(got);
			}
		};
		es.onerror = () => {
			if (got.length >= 2) return;
			clearTimeout(fail);
			es.close();
			reject(new Error('EventSource error'));
		};
	});
	expect(frames[0]).toEqual({ t: 'hello', conn: 'browser', v: 0 });
	expect(frames[1]).toEqual({ t: 'patch', view: 'orders', v: 1, ops: [] });
	document.body.replaceChildren();
	document.body.append(Object.assign(document.createElement('p'), { textContent: (frames[0] as { t: string }).t }));
	await expect.element(page.getByText('hello')).toBeInTheDocument();
});

test('liveStream parses EventSource frames', async () => {
	const frames: Frame[] = [];
	const stream = liveStream(
		() => new EventSource(PATHS.live),
		(f) => frames.push(f),
		() => {}
	);
	stream.want(true);
	try {
		await expect.poll(() => frames.length).toBeGreaterThanOrEqual(2);
		expect(frames[0]).toEqual({ t: 'hello', conn: 'browser', v: 0 });
		expect(frames[1]).toEqual({ t: 'patch', view: 'orders', v: 1, ops: [] });
	} finally {
		stream.want(false);
	}
});
