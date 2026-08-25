/**
 * The OpenRouter adapter against a local `node:http` stub: zero network, zero sleeping.
 *
 * The stub is a real HTTP server rather than a fake `fetch` wherever request *shape* matters,
 * because headers, URL paths and body bytes are exactly what a mock fetch would let us lie about.
 * Retry timing uses an injected delay that records its calls, so backoff order is asserted
 * without waiting 3.25 real seconds. Every counter claim (attempts include retries, tokens sum
 * across batches, cost only when reported) is checked against what the stub actually served.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
	QUERY_INSTRUCTION,
	createOpenRouterEmbedder
} from '../../build/semantic/provider/openrouter.js';

type StubRequest = Readonly<{
	url: string | undefined;
	method: string | undefined;
	authorization: string | undefined;
	body: Readonly<{
		model?: unknown;
		input?: unknown;
		encoding_format?: unknown;
		dimensions?: unknown;
	}>;
}>;

type StubHandler = (
	request: StubRequest,
	reply: (status: number, payload: string) => void
) => Promise<void> | void;

const startStub = async (handler: StubHandler): Promise<{ url: string; requests: Array<StubRequest>; close: () => Promise<void> }> => {
	const requests: Array<StubRequest> = [];
	const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Array<Buffer> = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			const recorded: StubRequest = {
				url: request.url,
				method: request.method,
				authorization: request.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
			};
			requests.push(recorded);
			void Promise.resolve(
				handler(recorded, (status, payload) => {
					response.statusCode = status;
					response.setHeader('content-type', 'application/json');
					response.end(payload);
				})
			).catch((error: unknown) => {
				response.statusCode = 500;
				response.end(String(error instanceof Error ? error.message : error));
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
};

/** Deterministic vector for one text: sha256 bytes stretched across `dimensions`. */
const vectorFor = (text: string, dimensions: number): Array<number> =>
	Array.from({ length: dimensions }, (_, index) => {
		const byte = createHash('sha256').update(`${text}#${index}`).digest()[index % 32];
		return ((byte ?? 0) / 255) * 2 - 1;
	});

const embedPayload = (inputs: ReadonlyArray<string>, dimensions: number, usage?: object): string =>
	JSON.stringify({
		data: inputs.map((text) => ({ embedding: vectorFor(text, dimensions) })),
		...(usage === undefined ? {} : { usage })
	});

test('requests carry auth, wire fields, and are batched at 32 inputs', async () => {
	const stub = await startStub((request, reply) => {
		reply(200, embedPayload(request.body.input as Array<string>, 4, { prompt_tokens: 1 }));
	});
	try {
		const embedder = createOpenRouterEmbedder({
			apiKey: 'test-key',
			dimensions: 4,
			endpoint: stub.url
		});
		const texts = Array.from({ length: 70 }, (_, index) => `document ${index}`);
		const vectors = await embedder.embed(texts, 'document');

		assert.equal(stub.requests.length, 3);
		assert.deepEqual(
			stub.requests.map((request) => (request.body.input as Array<string>).length),
			[32, 32, 6]
		);
		for (const request of stub.requests) {
			assert.equal(request.method, 'POST');
			assert.equal(request.url, '/embeddings');
			assert.equal(request.authorization, 'Bearer test-key');
			assert.equal(request.body.model, 'qwen/qwen3-embedding-8b');
			assert.equal(request.body.encoding_format, 'float');
			assert.equal(request.body.dimensions, 4);
		}

		// Alignment: output i corresponds to input i across batch boundaries.
		assert.equal(vectors.length, texts.length);
		for (const [index, text] of texts.entries()) {
			const expected = new Float32Array(vectorFor(text, 4));
			assert.deepEqual([...(vectors[index] ?? [])], [...expected]);
		}

		const usage = embedder.usage();
		assert.equal(usage.apiRequests, 3);
		assert.equal(usage.promptTokens, 3);
		assert.equal(usage.costUsd, undefined);
	} finally {
		await stub.close();
	}
});

test('query inputs get the instruction prefix, documents pass verbatim', async () => {
	let seenQuery: Array<string> = [];
	let seenDocument: Array<string> = [];
	const stub = await startStub((request, reply) => {
		if ((request.body.input as Array<string>)?.[0]?.startsWith('Instruct:'))
			seenQuery = request.body.input as Array<string>;
		else seenDocument = request.body.input as Array<string>;
		reply(200, embedPayload(request.body.input as Array<string>, 4));
	});
	try {
		const embedder = createOpenRouterEmbedder({ apiKey: 'k', dimensions: 4, endpoint: stub.url });
		await embedder.embed(['needle'], 'query');
		await embedder.embed(['haystack'], 'document');
		assert.deepEqual(seenQuery, [`${QUERY_INSTRUCTION}needle`]);
		assert.deepEqual(seenDocument, ['haystack']);
	} finally {
		await stub.close();
	}
});

test('the instruction constant participates in the embedder id', () => {
	const embedder = createOpenRouterEmbedder({ apiKey: 'k', dimensions: 7 });
	const tag = createHash('sha256').update(QUERY_INSTRUCTION).digest('hex').slice(0, 8);
	assert.equal(embedder.id, `openrouter:qwen/qwen3-embedding-8b:7:q${tag}`);
});

test('429 responses retry on the fixed schedule and then succeed', async () => {
	let attempts = 0;
	const delays: Array<number> = [];
	const stub = await startStub((_request, reply) => {
		attempts += 1;
		if (attempts <= 2) reply(429, 'rate limited');
		else reply(200, embedPayload(['hello'], 4, { prompt_tokens: 5, cost: 0.02 }));
	});
	try {
		const embedder = createOpenRouterEmbedder({
			apiKey: 'k',
			dimensions: 4,
			endpoint: stub.url,
			delay: async (ms) => {
				delays.push(ms);
			}
		});
		const vectors = await embedder.embed(['hello'], 'document');
		assert.equal(vectors.length, 1);
		assert.deepEqual(delays, [250, 1000]);
		const usage = embedder.usage();
		assert.equal(usage.apiRequests, 3);
		assert.equal(usage.promptTokens, 5);
		assert.equal(usage.costUsd, 0.02);
	} finally {
		await stub.close();
	}
});

test('exhausted retries throw the loud failure with status and body snippet', async () => {
	const delays: Array<number> = [];
	const stub = await startStub((_request, reply) => {
		reply(529, 'origin overloaded beyond all capacity and then some');
	});
	try {
		const embedder = createOpenRouterEmbedder({
			apiKey: 'k',
			dimensions: 4,
			endpoint: stub.url,
			delay: async (ms) => {
				delays.push(ms);
			}
		});
		await assert.rejects(
			embedder.embed(['x'], 'document'),
			/norbital-doctor: openrouter embeddings failed \(529\): origin overloaded.{0,200}$/
		);
		assert.deepEqual(delays, [250, 1000, 2000]);
		assert.equal(stub.requests.length, 4);
	} finally {
		await stub.close();
	}
});

test('network failures retry and then fail as network errors, attempts counted', async () => {
	const delays: Array<number> = [];
	let calls = 0;
	const embedder = createOpenRouterEmbedder({
		apiKey: 'k',
		dimensions: 4,
		fetchImpl: (() => {
			calls += 1;
			return Promise.reject(new Error('socket hang up'));
		}) as typeof fetch,
		delay: async (ms) => {
			delays.push(ms);
		}
	});
	await assert.rejects(
		embedder.embed(['x'], 'document'),
		/norbital-doctor: openrouter embeddings failed \(network\): socket hang up/
	);
	assert.deepEqual(delays, [250, 1000, 2000]);
	assert.equal(calls, 4);
	assert.equal(embedder.usage().apiRequests, 4);
});

test('usage stays undefined when the provider reports nothing, and accumulates when it does', async () => {
	const silent = await startStub((request, reply) => {
		reply(200, embedPayload(request.body.input as Array<string>, 4));
	});
	try {
		const embedder = createOpenRouterEmbedder({ apiKey: 'k', dimensions: 4, endpoint: silent.url });
		await embedder.embed(['a', 'b'], 'document');
		const usage = embedder.usage();
		assert.equal(usage.promptTokens, undefined);
		assert.equal(usage.costUsd, undefined);
	} finally {
		await silent.close();
	}
});

test('a response whose embeddings do not match the declared width fails loudly', async () => {
	const stub = await startStub((request, reply) => {
		reply(
			200,
			JSON.stringify({ data: (request.body.input as Array<string>).map(() => ({ embedding: [1, 2] })) })
		);
	});
	try {
		const embedder = createOpenRouterEmbedder({ apiKey: 'k', dimensions: 4, endpoint: stub.url });
		await assert.rejects(
			embedder.embed(['x', 'y'], 'document'),
			/norbital-doctor: openrouter embeddings failed \(200\): embedding 0 has 2 dimensions, expected 4/
		);
	} finally {
		await stub.close();
	}
});
