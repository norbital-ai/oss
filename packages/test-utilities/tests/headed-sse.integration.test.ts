import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, it, type TestContext } from 'node:test';
import {
	guestUrlForChromium,
	launchChromium,
	MissingChromiumError,
	type HeadedBrowser
} from '../src/headed-chromium.ts';

const nativeDocument = `<!doctype html>
<meta charset="utf-8" />
<title>sse-native</title>
<script>
window.__sse = { open: false, events: [], error: null, kind: 'native' };
const source = new EventSource('/sse');
source.addEventListener('open', () => { window.__sse.open = true; });
source.addEventListener('hello', (event) => { window.__sse.events.push(['hello', event.data]); });
source.addEventListener('apply', (event) => { window.__sse.events.push(['apply', event.data]); });
source.onerror = (event) => { window.__sse.error = String(event?.type ?? 'error'); };
</script>`;

const xhrDocument = `<!doctype html>
<meta charset="utf-8" />
<title>sse-xhr</title>
<script>
window.__sse = { open: false, events: [], error: null, kind: 'xhr', readyState: 0, bytes: 0 };
const emit = (type, data) => { window.__sse.events.push([type, data]); };
const xhr = new XMLHttpRequest();
let seen = 0;
let buffer = '';
const consume = (text) => {
	if (text.length <= seen) return;
	buffer += text.slice(seen);
	seen = text.length;
	window.__sse.bytes = seen;
	for (;;) {
		const split = buffer.indexOf('\\n\\n');
		if (split < 0) break;
		const raw = buffer.slice(0, split);
		buffer = buffer.slice(split + 2);
		let event = 'message';
		const data = [];
		for (const line of raw.split('\\n')) {
			if (line.startsWith('event:')) event = line.slice(6).trim();
			else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
		}
		if (data.length > 0) emit(event, data.join('\\n'));
	}
};
xhr.open('GET', '/sse', true);
xhr.onreadystatechange = () => {
	window.__sse.readyState = xhr.readyState;
	if (window.__sse.open === false && xhr.readyState >= 2 && xhr.status === 200) {
		window.__sse.open = true;
	}
	if (xhr.readyState === 3 || xhr.readyState === 4) consume(xhr.responseText ?? '');
};
xhr.onerror = () => { window.__sse.error = 'xhr'; };
xhr.send();
</script>`;

const fetchDocument = `<!doctype html>
<meta charset="utf-8" />
<title>sse-fetch</title>
<script>
window.__sse = { open: false, events: [], error: null, kind: 'fetch', bytes: 0 };
const emit = (type, data) => { window.__sse.events.push([type, data]); };
(async () => {
	try {
		const response = await fetch('/sse');
		window.__sse.open = response.ok;
		window.__sse.status = response.status;
		if (response.body === null) {
			window.__sse.error = 'nobody';
			return;
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			window.__sse.bytes = (window.__sse.bytes ?? 0) + (value ? value.length : 0);
			for (;;) {
				const split = buffer.indexOf('\\n\\n');
				if (split < 0) break;
				const raw = buffer.slice(0, split);
				buffer = buffer.slice(split + 2);
				let event = 'message';
				const data = [];
				for (const line of raw.split('\\n')) {
					if (line.startsWith('event:')) event = line.slice(6).trim();
					else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
				}
				if (data.length > 0) emit(event, data.join('\\n'));
			}
		}
	} catch (error) {
		window.__sse.error = String(error);
	}
})();
</script>`;

const listen = (server: ReturnType<typeof createServer>): Promise<{ port: number; host: string }> =>
	new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				reject(new Error('sse fixture did not bind'));
				return;
			}
			resolve({ port: address.port, host: '127.0.0.1' });
		});
	});

type SseSnap = {
	readonly open: boolean;
	readonly events: readonly (readonly [string, string])[];
	readonly error: string | null;
};

const snapshotOf = async (page: {
	evaluate: (expression: string) => Promise<unknown>;
}): Promise<SseSnap> => {
	const raw = await page.evaluate('JSON.stringify(window.__sse)');
	assert.equal(typeof raw, 'string');
	return JSON.parse(String(raw)) as SseSnap;
};

const driveSse = async (
	t: TestContext,
	document: string
): Promise<{
	readonly afterOpen: SseSnap;
	readonly afterApply: SseSnap;
	readonly sinksAfterOpen: number;
	readonly receipt: { sinks: number; closed: number };
}> => {
	const sinks = new Set<ServerResponse>();
	let closed = 0;
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		if (url.pathname === '/' && request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			response.end(document);
			return;
		}
		if (url.pathname === '/sse' && request.method === 'GET') {
			response.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store',
				connection: 'keep-alive'
			});
			response.write('event: hello\ndata: ready\n\n');
			sinks.add(response);
			response.once('close', () => {
				sinks.delete(response);
				closed += 1;
			});
			return;
		}
		if (url.pathname === '/push' && request.method === 'POST') {
			for (const sink of sinks) sink.write('event: apply\ndata: mutated\n\n');
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ sinks: sinks.size, closed }));
			return;
		}
		response.writeHead(404);
		response.end();
	});
	const address = await listen(server);
	let browser: HeadedBrowser | undefined;
	try {
		try {
			browser = await launchChromium();
		} catch (error: unknown) {
			if (error instanceof MissingChromiumError) {
				t.skip(error.message);
				throw error;
			}
			throw error;
		}
		const page = await browser.openPage(guestUrlForChromium(address.host, address.port, '/'));
		const openDeadline = Date.now() + 8_000;
		let afterOpen = await snapshotOf(page);
		while (Date.now() < openDeadline && afterOpen.open !== true) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			afterOpen = await snapshotOf(page);
		}
		const sinksAfterOpen = sinks.size;
		const pushed = await fetch(`http://127.0.0.1:${address.port}/push`, { method: 'POST' });
		const receipt = (await pushed.json()) as { sinks: number; closed: number };
		const applyDeadline = Date.now() + 5_000;
		let afterApply = await snapshotOf(page);
		while (Date.now() < applyDeadline && !afterApply.events.some(([name]) => name === 'apply')) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			afterApply = await snapshotOf(page);
		}
		return { afterOpen, afterApply, sinksAfterOpen, receipt };
	} finally {
		if (browser !== undefined) await browser.close();
		await new Promise<void>((resolve, reject) => {
			server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
			server.closeAllConnections();
		});
	}
};

const expectHelloThenApply = async (t: TestContext, document: string) => {
	const result = await driveSse(t, document);
	assert.equal(result.afterOpen.open, true, JSON.stringify(result.afterOpen));
	assert.deepEqual([...result.afterOpen.events], [['hello', 'ready']], JSON.stringify(result));
	assert.equal(result.sinksAfterOpen, 1, JSON.stringify(result));
	assert.equal(result.receipt.sinks, 1, JSON.stringify(result.receipt));
	assert.deepEqual(
		[...result.afterApply.events],
		[
			['hello', 'ready'],
			['apply', 'mutated']
		],
		JSON.stringify(result.afterApply)
	);
};

describe('Chromium SSE drivers', () => {
	it('native EventSource delivers hello and a later apply', (t) =>
		expectHelloThenApply(t, nativeDocument));
	it('XHR progressive response delivers hello and a later apply', (t) =>
		expectHelloThenApply(t, xhrDocument));
	it('fetch body reader delivers hello and a later apply', (t) =>
		expectHelloThenApply(t, fetchDocument));
});
