import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { telegramBot, telegramInboundMessage } from '../../src/host/telegram.js';
import type { ChannelInboundMessage, ChannelInboundResult } from '../../src/host/types.js';

const TOKEN = '1234:test-token';

type FakeTelegram = {
	readonly baseUrl: string;
	/** Batches handed out by successive `getUpdates` calls. */
	readonly pending: unknown[][];
	readonly sent: { chat_id: string; text: string }[];
	readonly offsets: (number | undefined)[];
	close(): Promise<void>;
};

/** A stand-in Bot API. Nothing here is Telegram's behaviour beyond the two shapes under test. */
async function startFakeTelegram(): Promise<FakeTelegram> {
	const pending: unknown[][] = [];
	const sent: { chat_id: string; text: string }[] = [];
	const offsets: (number | undefined)[] = [];
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
			response.setHeader('content-type', 'application/json');
			if (request.url === `/bot${TOKEN}/getUpdates`) {
				offsets.push(body.offset);
				response.end(JSON.stringify({ ok: true, result: pending.shift() ?? [] }));
				return;
			}
			if (request.url === `/bot${TOKEN}/sendMessage`) {
				sent.push({ chat_id: String(body.chat_id), text: String(body.text) });
				response.end(JSON.stringify({ ok: true }));
				return;
			}
			response.statusCode = 404;
			response.end(JSON.stringify({ ok: false, description: 'no such method' }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('fake Telegram has no port');
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		pending,
		sent,
		offsets,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}

async function waitFor<T>(produce: () => T | undefined, describeFailure: string): Promise<T> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const value = produce();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describeFailure}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('telegramInboundMessage', () => {
	it('maps a text message onto the inbound shape', () => {
		expect(
			telegramInboundMessage('sales_desk', {
				update_id: 7,
				message: {
					message_id: 42,
					text: '  How much for ten?  ',
					chat: { id: -100987 },
					from: { id: 55, first_name: 'Dana', last_name: 'Prospect', username: 'dana' }
				}
			})
		).toEqual({
			channel: 'sales_desk',
			conversationId: '-100987',
			// The message id, never the update id: a redelivered update keeps the message id, and that
			// is what the inbound ledger deduplicates on.
			messageId: '42',
			text: 'How much for ten?',
			sender: { id: '55', displayName: 'Dana Prospect' }
		});
	});

	it('skips an update carrying no text', () => {
		expect(telegramInboundMessage('sales_desk', { update_id: 8 })).toBeNull();
		expect(
			telegramInboundMessage('sales_desk', {
				update_id: 9,
				message: { message_id: 1, chat: { id: 5 } }
			})
		).toBeNull();
	});
});

describe('telegramBot', () => {
	let api: FakeTelegram;

	beforeAll(async () => {
		api = await startFakeTelegram();
	});

	afterAll(async () => {
		await api.close();
	});

	it('refuses a configuration that cannot address anything', () => {
		expect(() => telegramBot({ botToken: ' ', channel: 'sales_desk' })).toThrow(/bot token/);
		expect(() => telegramBot({ botToken: TOKEN, channel: '' })).toThrow(/channel/);
	});

	it('sends a reply to the conversation it came from', async () => {
		const bot = telegramBot({ botToken: TOKEN, channel: 'sales_desk', apiBaseUrl: api.baseUrl });
		expect(bot.transport.transport).toBe('telegram');
		const result = await bot.transport.send(
			{ conversationId: '-100987', text: 'Ten is £40.' },
			{ channel: 'sales_desk' }
		);
		expect(result.sent).toBe(true);
		expect(api.sent.at(-1)).toEqual({ chat_id: '-100987', text: 'Ten is £40.' });
	});

	it('reports a refusal rather than throwing', async () => {
		const bot = telegramBot({
			botToken: 'wrong-token',
			channel: 'sales_desk',
			apiBaseUrl: api.baseUrl
		});
		const result = await bot.transport.send(
			{ conversationId: '1', text: 'hello' },
			{ channel: 'sales_desk' }
		);
		expect(result.sent).toBe(false);
		expect(result.reason).toContain('404');
	});

	it('delivers polled messages and advances past every update it saw', async () => {
		const delivered: ChannelInboundMessage[] = [];
		api.pending.push([
			{
				update_id: 100,
				message: { message_id: 1, text: 'first', chat: { id: 9 }, from: { id: 3, first_name: 'A' } }
			},
			// No text: skipped, but the offset must still move past it or Telegram replays it forever.
			{ update_id: 101, message: { message_id: 2, chat: { id: 9 } } }
		]);
		const bot = telegramBot({
			botToken: TOKEN,
			channel: 'sales_desk',
			apiBaseUrl: api.baseUrl,
			pollTimeoutSeconds: 1,
			log: () => undefined
		});
		const stop = await bot.listen(async (message): Promise<ChannelInboundResult> => {
			delivered.push(message);
			return { status: 'answered', delivered: true };
		});
		try {
			await waitFor(() => (delivered.length > 0 ? delivered : undefined), 'a delivered message');
			expect(delivered[0]?.text).toBe('first');
			expect(delivered[0]?.conversationId).toBe('9');
			// The first call carries no offset; a later one asks for everything after update 101.
			await waitFor(
				() => (api.offsets.includes(102) ? true : undefined),
				`the offset to advance to 102 (saw ${api.offsets.join(',')})`
			);
		} finally {
			stop();
		}
	});
});
