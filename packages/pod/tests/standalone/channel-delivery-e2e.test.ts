import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDocker, startPostgres, type PgHarness } from '../support/pg-harness.js';

requireDocker();
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const POD_BIN = path.join(REPO_ROOT, 'packages/pod/build/bin/invocation/index.js');

/** The channel the `crm` template declares: `telegram`, under the `sales_rep` policy. */
const CHANNEL = 'sales_desk';
const CONVERSATION = 'tg-chat-90210';

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Unable to allocate test port');
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

function waitForOutput(
	child: ChildProcessWithoutNullStreams,
	pattern: RegExp,
	timeoutMs = 30_000
): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = '';
		const timeout = setTimeout(
			() => reject(new Error(`Timed out waiting for ${pattern}: ${output}`)),
			timeoutMs
		);
		const consume = (chunk: Buffer) => {
			output += chunk.toString('utf8');
			if (!pattern.test(output)) return;
			clearTimeout(timeout);
			resolve(output);
		};
		child.stdout.on('data', consume);
		child.stderr.on('data', consume);
		child.once('exit', (code) => {
			clearTimeout(timeout);
			if (!pattern.test(output)) reject(new Error(`Pod exited ${code}: ${output}`));
		});
	});
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill('SIGTERM');
	await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

/** What the host's `telegram` transport actually put on the wire. */
type SentMessage = {
	readonly channel: string;
	readonly conversationId: string;
	readonly text: string;
};

type Sink = {
	readonly url: string;
	readonly sent: SentMessage[];
	close(): Promise<void>;
};

/**
 * The far end of the transport.
 *
 * Outbound has to leave the Pod process over a socket for this to prove anything: the reply is
 * produced inside the runtime, handed to `messaging.sendVia('sales_desk', 'telegram', …)`, and only
 * then does the host's transport POST it here. A received body is proof the whole chain ran.
 */
async function startSink(): Promise<Sink> {
	const sent: SentMessage[] = [];
	const server: Server = createHttpServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			try {
				sent.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as SentMessage);
				response.statusCode = 204;
			} catch {
				response.statusCode = 400;
			}
			response.end();
		});
	});
	const port = await freePort();
	await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
	return {
		url: `http://127.0.0.1:${port}`,
		sent,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}

/**
 * A host that holds one conversational wire and one model.
 *
 * The transport is fake in the sense that it speaks HTTP to a test sink instead of Telegram, but it
 * is a real `MessagingTransport` reached through the real facility binding. The `ai` binding is
 * scripted rather than stubbed to nothing: it calls two collections, one the `sales_rep` policy
 * grants and one it does not, and reports what came back — which is how the run proves the declared
 * policy is in force rather than merely declared.
 */
const HOST_SOURCE = `import { createServer } from 'node:http';
import {
	definePodHost,
	devIdentity,
	env,
	intervalQueue,
	localFileStorage,
	messagingProviders,
	postgresDb
} from '@norbital-ai/pod/host';

const verdict = (results, id) => {
	const row = results.find((message) => message.toolCallId === id);
	if (!row) return 'missing';
	try {
		return JSON.parse(row.content).error ? 'denied' : 'ok';
	} catch {
		return 'unreadable';
	}
};

export default definePodHost({
	mode: 'self-hosted',
	db: postgresDb({ url: env('DATABASE_URL') }),
	publicUrl: \`http://\${env('POD_HOST')}:\${env('POD_PORT')}\`,
	identity: devIdentity({
		userId: env('POD_ADMIN_ID'),
		organizationId: env('POD_ORG_ID'),
		organizationName: env('POD_ORG_NAME')
	}),
	fileStorage: localFileStorage({ directory: '.norbital/storage' }),
	queue: intervalQueue({ intervalMs: 1000 }),
	ai: {
		chat: async (input) => {
			const messages = input.messages ?? [];
			const results = messages.filter((message) => message.role === 'tool');
			if (results.length === 0) {
				return {
					text: '',
					stopReason: 'tool_use',
					toolCalls: [
						{ id: 'call_accounts', name: 'read_collection', input: { collection: 'accounts', limit: 1 } },
						{ id: 'call_payments', name: 'read_collection', input: { collection: 'payment_records', limit: 1 } }
					]
				};
			}
			const lastUser = [...messages].reverse().find((message) => message.role === 'user');
			return {
				text:
					\`answering=\${lastUser?.content ?? ''}\` +
					\` accounts=\${verdict(results, 'call_accounts')}\` +
					\` payments=\${verdict(results, 'call_payments')}\` +
					\` prompt_messages=\${messages.length}\`,
				stopReason: 'end'
			};
		}
	},
	messaging: messagingProviders({
		channels: [
			{
				channel: 'email',
				send: async () => ({ sent: true })
			}
		],
		transports: [
			{
				transport: 'telegram',
				send: async (message, context) => {
					const response = await fetch(\`\${env('POD_TEST_SINK_URL')}/sent\`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ ...message, channel: context.channel })
					});
					if (!response.ok) return { sent: false, reason: \`sink answered \${response.status}\` };
					return { sent: true };
				}
			}
		]
	}),
	channels: async (deliver) => {
		const server = createServer((request, response) => {
			const chunks = [];
			request.on('data', (chunk) => chunks.push(chunk));
			request.on('end', () => {
				void (async () => {
					try {
						const outcome = await deliver(JSON.parse(Buffer.concat(chunks).toString('utf8')));
						response.statusCode = 200;
						response.setHeader('content-type', 'application/json');
						response.end(JSON.stringify(outcome));
					} catch (cause) {
						response.statusCode = 500;
						response.setHeader('content-type', 'application/json');
						response.end(
							JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) })
						);
					}
				})();
			});
		});
		await new Promise((resolve) =>
			server.listen(Number(env('POD_TEST_INBOUND_PORT')), '127.0.0.1', resolve)
		);
		return () => server.close();
	}
});
`;

async function writeWorkspace(root: string): Promise<void> {
	await cp(path.join(REPO_ROOT, 'template_workspaces/crm'), root, {
		recursive: true,
		filter: (source) => !source.includes(`${path.sep}.norbital${path.sep}build`)
	});
	await writeFile(path.join(root, 'pod.host.ts'), HOST_SOURCE);
}

type InboundOutcome = {
	readonly status?: string;
	readonly chatId?: string;
	readonly text?: string;
	readonly delivered?: boolean;
	readonly error?: string;
};

describe('Pod standalone channel delivery — E2E', () => {
	let pg: PgHarness;
	let root: string;
	let sink: Sink;
	let inboundPort: number;
	let environment: NodeJS.ProcessEnv;
	let running: ChildProcessWithoutNullStreams;
	let log = '';

	const deliver = async (message: {
		messageId: string;
		text: string;
		conversationId?: string;
		channel?: string;
	}): Promise<InboundOutcome> => {
		const response = await fetch(`http://127.0.0.1:${inboundPort}/inbound`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				channel: message.channel ?? CHANNEL,
				conversationId: message.conversationId ?? CONVERSATION,
				messageId: message.messageId,
				text: message.text,
				sender: { id: 'tg-user-77', displayName: 'Dana Prospect' }
			})
		});
		return (await response.json()) as InboundOutcome;
	};

	const queryTenant = async <T>(text: string, values: unknown[] = []): Promise<readonly T[]> => {
		const client = new Client({ connectionString: pg.connectionString });
		await client.connect();
		try {
			return (await client.query(text, values)).rows as T[];
		} finally {
			await client.end();
		}
	};

	beforeAll(async () => {
		pg = await startPostgres();
		sink = await startSink();
		inboundPort = await freePort();
		const parent = path.join(REPO_ROOT, '.test-workspaces');
		await mkdir(parent, { recursive: true });
		root = await mkdtemp(path.join(parent, 'channel-delivery-'));
		await writeWorkspace(root);

		const port = await freePort();
		environment = {
			...process.env,
			DATABASE_URL: pg.connectionString,
			POD_HOST: '127.0.0.1',
			POD_PORT: String(port),
			POD_ORG_ID: '33333333-3333-4333-8333-333333333333',
			POD_ORG_NAME: 'Channel Delivery Test',
			POD_ADMIN_ID: '44444444-4444-4444-8444-444444444444',
			POD_ADMIN_NAME: 'Channel Admin',
			POD_ADMIN_EMAIL: 'admin@channel.test',
			POD_TEMPLATE_KEY: 'crm',
			POD_TEST_SINK_URL: sink.url,
			POD_TEST_INBOUND_PORT: String(inboundPort)
		};
		execFileSync('node', [POD_BIN, 'build'], { cwd: root, env: environment, stdio: 'ignore' });
		execFileSync('node', [POD_BIN, 'migrate'], { cwd: root, env: environment, stdio: 'ignore' });

		running = spawn('node', [POD_BIN, 'start'], { cwd: root, env: environment, stdio: 'pipe' });
		running.stdout.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
		running.stderr.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
		await waitForOutput(running, /Pod listening at/);
	}, 300_000);

	afterAll(async () => {
		if (running) await stop(running);
		await sink?.close();
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
		pg?.stop();
	});

	it('gives the declared channel a principal carrying its declared policy', async () => {
		const rows = await queryTenant<{ email: string; kind: string; policy_key: string }>(
			`SELECT u.email, u.kind, p.key AS policy_key
			   FROM "user" u
			   JOIN team_members tm ON tm.user_id = u.norbital_id
			   JOIN team t ON t.norbital_id = tm.team_id
			   JOIN policy p ON p.norbital_id = t.policy_id
			  WHERE u.email = $1`,
			[`channel.${CHANNEL}@channels.invalid`]
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe('agent');
		expect(rows[0]?.policy_key).toBe('sales_rep');
	});

	it('answers an inbound message back over the transport it arrived on', async () => {
		const outcome = await deliver({ messageId: 'tg-msg-1', text: 'Do you have a quote for us?' });
		expect(outcome.error, `inbound failed. Pod log:\n${log}`).toBeUndefined();
		expect(outcome.status).toBe('answered');
		expect(outcome.delivered).toBe(true);

		expect(sink.sent).toHaveLength(1);
		expect(sink.sent[0]?.channel).toBe(CHANNEL);
		expect(sink.sent[0]?.conversationId).toBe(CONVERSATION);
		// The agent's own words left the process over the transport, not a canned acknowledgement.
		expect(sink.sent[0]?.text).toContain('answering=Do you have a quote for us?');
	});

	it('runs the agent under the channel policy, not the host identity', async () => {
		// `sales_rep` grants read on `accounts` and nothing at all on `payment_records`. The host command
		// arrives as the administrator, who could read both — so a denial here is proof the run switched
		// to the channel principal and that the declared policy is the thing being enforced.
		expect(sink.sent[0]?.text).toContain('accounts=ok');
		expect(sink.sent[0]?.text).toContain('payments=denied');
	});

	it('stores the transcript and the inbound receipt', async () => {
		const conversations = await queryTenant<{
			norbital_id: string;
			chat_id: string;
			transport: string;
			last_outbound_at: string | null;
		}>(`SELECT norbital_id, chat_id, transport, last_outbound_at FROM channel_conversation`);
		expect(conversations).toHaveLength(1);
		expect(conversations[0]?.transport).toBe('telegram');
		expect(conversations[0]?.last_outbound_at).not.toBeNull();

		const receipts = await queryTenant<{
			status: string;
			external_message_id: string;
			sender_display_name: string | null;
			chat_message_id: string | null;
		}>(`SELECT status, external_message_id, sender_display_name, chat_message_id
		      FROM channel_inbound_message`);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.status).toBe('answered');
		expect(receipts[0]?.sender_display_name).toBe('Dana Prospect');
		expect(receipts[0]?.chat_message_id).not.toBeNull();

		const messages = await queryTenant<{
			role: string;
			seq: number;
			source_message_id: string | null;
		}>(
			`SELECT role, seq, source_message_id FROM chat_message WHERE chat_id = $1::uuid ORDER BY seq`,
			[conversations[0]?.chat_id]
		);
		// user → assistant tool call → two tool results → assistant answer.
		expect(messages.map((message) => message.role)).toEqual([
			'user',
			'assistant',
			'tool',
			'tool',
			'assistant'
		]);
		expect(messages[0]?.source_message_id).toBe('tg-msg-1');
	});

	it('drops a redelivery of the same transport message without running the agent', async () => {
		const before = sink.sent.length;
		const outcome = await deliver({ messageId: 'tg-msg-1', text: 'Do you have a quote for us?' });
		expect(outcome.status).toBe('duplicate');
		expect(sink.sent).toHaveLength(before);
		const receipts = await queryTenant(`SELECT 1 FROM channel_inbound_message`);
		expect(receipts).toHaveLength(1);
	});

	it('continues the same transcript for the next message in the conversation', async () => {
		const outcome = await deliver({ messageId: 'tg-msg-2', text: 'And the lead time?' });
		expect(outcome.status).toBe('answered');
		expect(sink.sent).toHaveLength(2);
		expect(sink.sent[1]?.text).toContain('answering=And the lead time?');

		const conversations = await queryTenant<{ chat_id: string }>(
			`SELECT chat_id FROM channel_conversation`
		);
		// One conversation, one transcript: the follow-up did not open a second session.
		expect(conversations).toHaveLength(1);

		const counted = await queryTenant<{ count: string }>(
			`SELECT count(*)::text AS count FROM chat_message WHERE chat_id = $1::uuid`,
			[conversations[0]?.chat_id]
		);
		expect(Number(counted[0]?.count)).toBeGreaterThan(5);

		// The second turn saw the first: the model was handed more than a fresh system prompt plus one
		// user line, which is what replaying the session's history means.
		const promptSize = /prompt_messages=(\d+)/.exec(sink.sent[1]?.text ?? '')?.[1];
		expect(Number(promptSize)).toBeGreaterThan(2);
	});

	it('refuses a message for a channel the workspace does not declare', async () => {
		const outcome = await deliver({
			channel: 'not_a_channel',
			messageId: 'tg-msg-3',
			text: 'hello?'
		});
		expect(outcome.error).toContain('Unknown channel "not_a_channel"');
		expect(outcome.error).toContain(CHANNEL);
	});
});
