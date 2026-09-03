import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
	guestUrlForChromium,
	launchChromium,
	MissingChromiumError
} from '../src/headed-chromium.ts';

const WRAP_DOCUMENT = `<!doctype html>
<meta charset="utf-8" />
<title>wrap</title>
<script>
window.__pageTag = document.title;
</script>`;

const listen = (body: string): Promise<{ port: number; stop: () => Promise<void> }> =>
	new Promise((resolve, reject) => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			response.end(body);
		});
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				reject(new Error('wrap fixture did not bind'));
				return;
			}
			resolve({
				port: address.port,
				stop: () =>
					new Promise<void>((done, fail) => {
						server.close((cause) => (cause === undefined ? done() : fail(cause)));
						server.closeAllConnections();
					})
			});
		});
	});

describe('launchChromium', () => {
	it('evaluates in a page', async (t) => {
		let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
		try {
			browser = await launchChromium();
		} catch (error: unknown) {
			if (error instanceof MissingChromiumError) {
				t.skip(error.message);
				return;
			}
			throw error;
		}
		try {
			const page = await browser.openPage('about:blank');
			assert.equal(await page.evaluate('1 + 1'), 2);
			await page.close();
		} finally {
			await browser.close();
		}
	});

	it('keeps two pages live in one Chromium', async (t) => {
		const fixture = await listen(WRAP_DOCUMENT);
		let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
		try {
			try {
				browser = await launchChromium();
			} catch (error: unknown) {
				if (error instanceof MissingChromiumError) {
					t.skip(error.message);
					return;
				}
				throw error;
			}
			const pageUrl = guestUrlForChromium('127.0.0.1', fixture.port, '/');
			const pageA = await browser.openPage(pageUrl);
			const pageB = await browser.openPage(pageUrl);
			assert.equal(await pageA.evaluate('document.title'), 'wrap');
			assert.equal(await pageB.evaluate('document.title'), 'wrap');
		} finally {
			if (browser !== undefined) await browser.close();
			await fixture.stop();
		}
	});
});
