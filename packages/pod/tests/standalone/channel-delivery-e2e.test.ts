import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

/**
 * A value only the host process holds, returned by its one host tool.
 *
 * Here it is a string that must never reach a channel transcript. The host registers `sandbox_probe`
 * and the runtime can dispatch it, so this is reachable from the process serving the channel; its
 * absence from every answer is what proves the withholding is real rather than declared.
 */
const RECEIPT = 'channel-host-receipt-4b7e';
/** Distinctive enough to locate inside the composed system prompt, and to prove which layer it is. */
const AUTHORED_MARKER = 'CHANNEL_AUTHORED_PROMPT';

/** The tool names the model reported being offered, out of the answer it wrote them into. */
function offered(text: string): readonly string[] {
	return (/offered=(\S+)/.exec(text)?.[1] ?? '').split('|');
}

async function pollUntil<T>(
	read: () => Promise<T> | T,
	predicate: (value: T) => boolean,
	timeoutMs = 30_000
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last!: T;
	while (Date.now() < deadline) {
		last = await read();
		if (predicate(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for condition (last=${JSON.stringify(last)})`);
}

async function waitForSinkCount(sink: Sink, count: number): Promise<void> {
	await pollUntil(
		() => sink.sent.length,
		(length) => length >= count
	);
}

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
 * A workspace tool, so "every workspace tool" is a claim with something in it.
 *
 * Never called: the channel agent is asked to prove the tool was *offered*, and running it would
 * only re-test `defineAgentTool`.
 */
const WORKSPACE_TOOL_SOURCE = `import { defineAgentTool } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export default defineAgentTool({
	description: 'List quotes the requestor may see.',
	input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
	run: async (api, input) => api.db.query.quotes.findMany({ limit: input.limit ?? 5 })
});
`;

/**
 * An authored profile that is narrower than the channel it cannot narrow.
 *
 * `access: 'read'`, one collection and no tools at all: if any of it applied to a channel run, the
 * offered list below would collapse and the reads would fail. Its prompt, which is the half a channel
 * *does* take, carries a marker so its position in the composed prompt can be checked.
 */
const AGENT_SOURCE = `import type { AgentAutomationSpec } from '@norbital-ai/pod/authoring';

export default {
	kind: 'agent',
	description: 'The workspace assistant sales staff talk to about quotes.',
	task: 'Assist with this sales workspace.',
	systemPrompt: '${AUTHORED_MARKER} — the workspace speaking to its own agent.',
	collections: ['quotes'],
	access: 'read',
	tools: [],
	hostTools: []
} satisfies AgentAutomationSpec;
`;

const AUTHENTICATED_CHANNEL_SOURCE = `import { defineChannel } from '@norbital-ai/pod/authoring';

export default defineChannel({
	transport: 'telegram',
	policy: 'sales_rep',
	description: 'Assigned members only.',
	audience: 'authenticated',
	groupMessages: 'disabled'
});
`;

/**
 * A host that holds one conversational wire, one model and one sandbox-shaped tool.
 *
 * The transport is fake in the sense that it speaks HTTP to a test sink instead of Telegram, but it
 * is a real `MessagingTransport` reached through the real facility binding. The `ai` binding is
 * scripted rather than stubbed to nothing: it calls two collections, one the `sales_rep` policy
 * grants and one it does not, and reports what came back — which is how the run proves the declared
 * policy is in force rather than merely declared. It also reports the tool list it was offered and
 * where each layer of the system prompt landed, because both are decisions made before any tool call
 * and are otherwise invisible from outside the process.
 */
const HOST_SOURCE = `import { createServer } from 'node:http';
import {
	definePodHost,
	devIdentity,
	env,
	httpIntegrationDelivery,
	intervalQueue,
	localFileStorage,
	messagingProviders,
	postgresDb
} from '@norbital-ai/pod/host';
import { z } from 'zod';

const verdict = (results, id) => {
	const row = results.find((message) => message.toolCallId === id);
	if (!row) return 'missing';
	try {
		return JSON.parse(row.content).error ? 'denied' : 'ok';
	} catch {
		return 'unreadable';
	}
};

const probeReceipt = (results, id) => {
	const row = results.find((message) => message.toolCallId === id);
	if (!row) return 'missing';
	try {
		const value = JSON.parse(row.content);
		return value.error ? \`denied(\${value.error})\` : String(value.receipt);
	} catch {
		return 'unreadable';
	}
};

/**
 * The messages this turn produced — everything after the last user message.
 *
 * A channel conversation replays its history, so filtering the whole window for tool results would
 * find the *previous* turn's results and answer for a call this turn never made. Every tool call id
 * below is a constant, so it would match, and a turn that had lost a permission would still report
 * the read it made while it had one.
 */
const thisTurn = (messages) => {
	let start = -1;
	for (const [index, message] of messages.entries()) {
		if (message.role === 'user') start = index;
	}
	return messages.slice(start + 1);
};

/** Where each authored layer starts in the one system message the loop composes. */
const layers = (messages) => {
	const system = messages.find((message) => message.role === 'system')?.content ?? '';
	return (
		\`baseline_at=\${system.indexOf('You are a Norbital agent')}\` +
		\` authored_at=\${system.indexOf('${AUTHORED_MARKER}')}\` +
		\` standing_at=\${system.indexOf('Answer questions about quotes and accounts')}\`
	);
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
	// The \`crm\` workspace declares an outbound integration, so a host that boots it has to be able to
	// deliver one. Nothing here enqueues a delivery; this is the wiring a real self-hosted crm has, and
	// leaving it out is what makes the workspace refuse to start.
	integrationDelivery: httpIntegrationDelivery(),
	agentTools: [
		{
			name: 'sandbox_probe',
			description: 'Return a value only the host process holds.',
			input: z.object({}),
			run: async () => ({ receipt: env('POD_TEST_HOST_RECEIPT') })
		}
	],
	ai: {
		chat: async (input) => {
			const messages = input.messages ?? [];
			const results = thisTurn(messages).filter((message) => message.role === 'tool');
			if (results.length === 0) {
				return {
					text: '',
					stopReason: 'tool_use',
					toolCalls: [
						{ id: 'call_accounts', name: 'read_collection', input: { collection: 'accounts', limit: 1 } },
						{ id: 'call_payments', name: 'read_collection', input: { collection: 'payment_records', limit: 1 } },
						{ id: 'call_probe', name: 'sandbox_probe', input: {} }
					]
				};
			}
			const lastUser = [...messages].reverse().find((message) => message.role === 'user');
			return {
				text:
					\`answering=\${lastUser?.content ?? ''}\` +
					\` accounts=\${verdict(results, 'call_accounts')}\` +
					\` payments=\${verdict(results, 'call_payments')}\` +
					\` probe=\${probeReceipt(results, 'call_probe')}\` +
					\` offered=\${(input.tools ?? []).map((tool) => tool.name).join('|')}\` +
					\` \${layers(messages)}\` +
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
	const packageScope = path.join(root, 'node_modules', '@norbital-ai');
	await rm(packageScope, { recursive: true, force: true });
	await symlink(path.join(REPO_ROOT, 'node_modules', '@norbital-ai'), packageScope, 'dir');
	await mkdir(path.join(root, 'src', 'tools'), { recursive: true });
	await writeFile(path.join(root, 'src', 'tools', '+list_quotes.tool.ts'), WORKSPACE_TOOL_SOURCE);
	await writeFile(
		path.join(root, 'src', 'channels', '+member_desk.channel.ts'),
		AUTHENTICATED_CHANNEL_SOURCE
	);
	await writeFile(path.join(root, 'src', '+agent.ts'), AGENT_SOURCE);
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
			POD_TEST_INBOUND_PORT: String(inboundPort),
			POD_TEST_HOST_RECEIPT: RECEIPT
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

	it('admits an inbound message as an automation receipt instead of awaiting the agent', async () => {
		const outcome = await deliver({ messageId: 'tg-msg-1', text: 'Do you have a quote for us?' });
		expect(outcome.error, `inbound failed. Pod log:\n${log}`).toBeUndefined();
		expect(outcome.status).toBe('accepted');
		expect(outcome.delivered).toBe(false);

		const jobs = await queryTenant<{
			automation_name: string;
			orchestration_status: string;
			trigger_key: string;
		}>(
			`SELECT automation_name, orchestration_status, trigger_key
			   FROM _norbital_automation_job
			  WHERE automation_name = $1`,
			[`channel:${CHANNEL}`]
		);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.orchestration_status).toBe('admitted');
		expect(jobs[0]?.trigger_key?.startsWith('turn:')).toBe(true);

		await waitForSinkCount(sink, 1);
	});

	it('answers an inbound message back over the transport it arrived on', () => {
		expect(sink.sent).toHaveLength(1);
		expect(sink.sent[0]?.channel).toBe(CHANNEL);
		expect(sink.sent[0]?.conversationId).toBe(CONVERSATION);
		// The agent's own words left the process over the transport, not a canned acknowledgement.
		expect(sink.sent[0]?.text).toContain('answering=Do you have a quote for us?');
	});

	it('runs the agent under the channel policy, not the host identity', () => {
		// `sales_rep` grants read on `accounts` and nothing at all on `payment_records`. The host command
		// arrives as the administrator, who could read both — so a denial here is proof the run switched
		// to the channel principal and that the declared policy is the thing being enforced.
		expect(sink.sent[0]?.text).toContain('accounts=ok');
		expect(sink.sent[0]?.text).toContain('payments=denied');
	});

	/**
	 * The whole workspace tool surface, in the order the loop builds it, and `write_collection` among
	 * it.
	 *
	 * Pinned exactly rather than by `toContain` because the claim is two-sided: nothing the workspace
	 * offers was curated away — the built-ins, the write tool that only an `access: 'write'` spec
	 * adds, the workspace's own tool — and nothing the host offers was added. The authored profile in
	 * this workspace says `access: 'read'` and `tools: []`, so every entry after the built-ins is also
	 * proof that a channel run does not take its permissions from that file.
	 */
	it('offers a channel run every workspace tool with write access', () => {
		expect(offered(sink.sent[0]?.text ?? '')).toEqual([
			'describe_workspace',
			'read_collection',
			'list_skills',
			'read_skill',
			'spawn_subagent',
			'write_collection',
			'list_quotes'
		]);
	});

	/**
	 * Baseline, then the authored profile, then the channel's declared task.
	 *
	 * Order is the assertion: a model resolves a conflict in favour of what it read last, so the
	 * platform's own instructions have to come first and the narrowest instruction — this channel's —
	 * has to come last.
	 */
	it('composes the authored src/+agent.ts prompt into a channel run', () => {
		const positions = sink.sent[0]?.text ?? '';
		const at = (name: string) => Number(new RegExp(`${name}_at=(-?\\d+)`).exec(positions)?.[1]);
		expect(at('baseline')).toBe(0);
		expect(at('authored')).toBeGreaterThan(at('baseline'));
		expect(at('standing')).toBeGreaterThan(at('authored'));
	});

	/**
	 * And the host tool this host does register is offered to nobody on this path.
	 *
	 * The model asks for it anyway, which is what makes this more than a list assertion: the call is
	 * refused at dispatch, so the receipt the host closure would have returned is absent from the
	 * answer entirely. A host tool acts as a principal no channel declaration chooses, so a group
	 * conversation must not be able to reach one.
	 */
	it('withholds host tools from a channel run and refuses one called anyway', () => {
		expect(offered(sink.sent[0]?.text ?? '')).not.toContain('sandbox_probe');
		expect(sink.sent[0]?.text).toContain('probe=denied(');
		expect(sink.sent[0]?.text).not.toContain(RECEIPT);
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
			session_message_id: string | null;
		}>(`SELECT status, external_message_id, sender_display_name, session_message_id
		      FROM channel_inbound_message`);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.status).toBe('answered');
		expect(receipts[0]?.sender_display_name).toBe('Dana Prospect');
		expect(receipts[0]?.session_message_id).not.toBeNull();

		const sessions = await queryTenant<{
			messages: readonly {
				role: string;
				seq: number;
				source_message_id: string | null;
			}[];
		}>(`SELECT messages FROM chat_session WHERE norbital_id = $1::uuid`, [
			conversations[0]?.chat_id
		]);
		const messages = sessions[0]?.messages ?? [];
		// user → assistant tool call → three tool results → assistant answer.
		expect(messages.map((message) => message.role)).toEqual([
			'user',
			'assistant',
			'tool',
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
		expect(outcome.status).toBe('accepted');
		await waitForSinkCount(sink, 2);
		expect(sink.sent[1]?.text).toContain('answering=And the lead time?');

		const conversations = await queryTenant<{ chat_id: string }>(
			`SELECT chat_id FROM channel_conversation`
		);
		// One conversation, one transcript: the follow-up did not open a second session.
		expect(conversations).toHaveLength(1);

		const counted = await queryTenant<{ count: string }>(
			`SELECT jsonb_array_length(messages)::text AS count
			   FROM chat_session
			  WHERE norbital_id = $1::uuid`,
			[conversations[0]?.chat_id]
		);
		expect(Number(counted[0]?.count)).toBeGreaterThan(5);

		// The second turn saw the first: the model was handed more than a fresh system prompt plus one
		// user line, which is what replaying the session's history means.
		const promptSize = /prompt_messages=(\d+)/.exec(sink.sent[1]?.text ?? '')?.[1];
		expect(Number(promptSize)).toBeGreaterThan(2);
	});

	it('prompts an unknown sender to register without starting an authenticated agent run', async () => {
		const beforeRuns = await queryTenant<{ count: string }>(
			`SELECT count(*)::text AS count FROM automation_run`
		);
		const outcome = await deliver({
			channel: 'member_desk',
			conversationId: 'member-dm-1',
			messageId: 'member-msg-1',
			text: 'Can I see the account?'
		});
		expect(outcome.status).toBe('registration_required');
		expect(outcome.delivered).toBe(true);
		expect(outcome.text).toMatch(/registered members/i);
		expect(sink.sent.at(-1)?.channel).toBe('member_desk');
		const admissionTranscript = await queryTenant<{
			messages: readonly { role: string; parts: readonly { content?: string }[] }[];
		}>(
			`SELECT s.messages
			   FROM channel_conversation cc
			   JOIN chat_session s ON s.norbital_id = cc.chat_id
			  WHERE cc.channel_key = 'member_desk' AND cc.external_conversation_id = 'member-dm-1'`
		);
		expect(admissionTranscript[0]?.messages.map((message) => message.role)).toEqual([
			'user',
			'assistant'
		]);
		expect(admissionTranscript[0]?.messages[1]?.parts[0]?.content).toMatch(/registered members/i);

		const afterRuns = await queryTenant<{ count: string }>(
			`SELECT count(*)::text AS count FROM automation_run`
		);
		expect(afterRuns[0]?.count).toBe(beforeRuns[0]?.count);
	});

	it('answers the same DM after its verified identity is assigned to an active account', async () => {
		const users = await queryTenant<{ norbital_id: string }>(
			`INSERT INTO "user" (email, name, status, role, kind, channels)
			 VALUES ('dana@channel.test', 'Dana Member', 'active', 'basic', 'human',
			         '[{"type":"telegram","verified":true,"telegram_user_id":"tg-user-77"}]'::jsonb)
			 RETURNING norbital_id`
		);
		await queryTenant(
			`INSERT INTO team (name, description, is_active, kind, policy_id)
			 SELECT 'Assigned sales members', 'Authenticated channel members', TRUE, 'human', norbital_id
			   FROM policy WHERE key = 'sales_rep'`
		);
		await queryTenant(
			`INSERT INTO team_members (user_id, team_id)
			 SELECT $1::uuid, norbital_id FROM team WHERE name = 'Assigned sales members'`,
			[users[0]?.norbital_id]
		);

		const before = sink.sent.length;
		const outcome = await deliver({
			channel: 'member_desk',
			conversationId: 'member-dm-1',
			messageId: 'member-msg-2',
			text: 'Can I see the account now?'
		});
		expect(outcome.status).toBe('accepted');
		await waitForSinkCount(sink, before + 1);
		expect(sink.sent.at(-1)?.text).toContain('answering=Can I see the account now?');

		const owners = await queryTenant<{ user_id: string; owner_user_id: string }>(
			`SELECT s.user_id, cc.owner_user_id
			   FROM channel_conversation cc
			   JOIN chat_session s ON s.norbital_id = cc.chat_id
			  WHERE cc.channel_key = 'member_desk' AND cc.external_conversation_id = 'member-dm-1'`
		);
		expect(owners[0]).toEqual({
			user_id: users[0]?.norbital_id,
			owner_user_id: users[0]?.norbital_id
		});
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

	/**
	 * A channel whose principal carries no policy can do nothing with the data.
	 *
	 * Last, because it takes the principal's team away and nothing after it would mean anything. That
	 * team is the only thing between an inbound message and this workspace — the run is offered write
	 * access and every tool — so its absence has to be a refusal rather than a fallback. This is the
	 * shape a channel left out of reconciliation, or renamed in source and not migrated, would have.
	 */
	it('refuses a channel principal that holds no policy', async () => {
		await queryTenant(
			`DELETE FROM team_members
			  WHERE user_id = (SELECT norbital_id FROM "user" WHERE lower(email) = lower($1))`,
			[`channel.${CHANNEL}@channels.invalid`]
		);
		// Checked rather than assumed: a delete that matched nothing would leave the principal fully
		// permissioned and this test would pass for the opposite reason.
		const remaining = await queryTenant(
			`SELECT tm.team_id
			   FROM team_members tm
			   JOIN "user" u ON u.norbital_id = tm.user_id
			  WHERE lower(u.email) = lower($1)`,
			[`channel.${CHANNEL}@channels.invalid`]
		);
		expect(remaining).toHaveLength(0);
		const before = sink.sent.length;
		const outcome = await deliver({ messageId: 'tg-msg-4', text: 'Anything for us now?' });
		expect(outcome.status).toBe('accepted');
		await waitForSinkCount(sink, before + 1);
		const answer = sink.sent.at(-1)?.text ?? '';
		expect(answer).toContain('accounts=denied');
		expect(answer).toContain('payments=denied');
		// And the host tool stays out of reach for the reason it always was, which is not this
		// principal's missing policy: it was never offered.
		expect(answer).toContain('probe=denied(');
	});
});
