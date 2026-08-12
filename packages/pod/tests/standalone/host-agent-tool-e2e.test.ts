import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDocker, startPostgres, type PgHarness } from '../support/pg-harness.js';
import { linkCurrentPodWorkspaceDependencies } from '../support/current-package-node-modules.js';

requireDocker();
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const POD_BIN = path.join(REPO_ROOT, 'packages/pod/build/bin/invocation/index.js');

const AUTOMATION = 'sandbox_deploy_watch';
const POD_ADMIN_ID = '66666666-6666-4666-8666-666666666666';
/**
 * A value only the *host process* holds.
 *
 * The point of the whole seam is that the tool body runs outside the workspace bundle, so the proof
 * has to be something the bundle could not have produced. This reaches the transcript only if the
 * host closure actually executed and its return value came back over the facility wire.
 */
const RECEIPT = 'host-receipt-9f2c41';

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

/** Run `pod start` to completion, expecting it to refuse. Returns everything it said. */
async function startAndExpectRefusal(
	root: string,
	environment: NodeJS.ProcessEnv
): Promise<{ code: number | null; output: string }> {
	const child = spawn('node', [POD_BIN, 'start'], { cwd: root, env: environment, stdio: 'pipe' });
	let output = '';
	child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
	child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
	const code = await new Promise<number | null>((resolve) => {
		const timeout = setTimeout(() => {
			child.kill('SIGKILL');
			resolve(null);
		}, 60_000);
		child.once('exit', (exitCode) => {
			clearTimeout(timeout);
			resolve(exitCode);
		});
	});
	return { code, output };
}

/**
 * A workspace agent tool, so the host has a name it could shadow.
 *
 * It never runs here — no agent names it. It exists to put `list_quotes` into the manifest's tool
 * namespace, which is exactly the thing a host cannot otherwise see.
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
 * An agent that opts in to one host tool and not the other.
 *
 * `* * * * *` so the interval queue's first sweep fires it: the run is the subject of the test, and
 * waiting a minute for it would only test the cron parser.
 */
const AUTOMATION_SOURCE = `import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation(
	{ schedule: '* * * * *' },
	{
		kind: 'agent',
		description: 'Deploys the workspace through the host sandbox and reports the outcome.',
		task: 'Deploy this workspace through the host sandbox and report what it said.',
		hostTools: ['sandbox_deploy']
	}
);
`;

/**
 * A host that holds a sandbox.
 *
 * `sandbox_deploy` is the tool the agent named; `sandbox_secret` is registered right beside it and
 * named by nobody, which is what makes the deny path meaningful — it is present, reachable by the
 * host, and still invisible to this agent.
 *
 * The two environment switches exist so the refusal cases can reuse this build rather than compile a
 * second workspace for each: renaming the tool makes the agent name something absent, and the shadow
 * switch registers a host tool called `list_quotes`, which the workspace already declares.
 */
const HOST_SOURCE = `import {
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

const deployToolName = env('POD_TEST_TOOL_NAME', 'sandbox_deploy');
const shadow = env('POD_TEST_SHADOW', '') === '1';

const verdict = (results, id) => {
	const row = results.find((message) => message.toolCallId === id);
	if (!row) return 'missing';
	try {
		const value = JSON.parse(row.content);
		return value.error ? \`denied(\${value.error})\` : \`ok(\${value.receipt}:\${value.target})\`;
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
	queue: intervalQueue({ intervalMs: 500 }),
	// The \`crm\` workspace declares an outbound integration, so a host that boots it has to be able to
	// deliver one. Nothing here enqueues a delivery; this is the wiring a real self-hosted crm has, and
	// leaving it out is what makes the workspace refuse to start.
	integrationDelivery: httpIntegrationDelivery(),
	agentTools: [
		{
			name: deployToolName,
			description: 'Deploy the workspace from the host sandbox.',
			input: z.object({ target: z.string().min(1) }),
			run: async (input, context) => ({
				ran: 'host',
				receipt: env('POD_TEST_HOST_RECEIPT'),
				target: input.target,
				principal: context?.sandboxPrincipalId
			})
		},
		{
			name: 'sandbox_secret',
			description: 'Read a host credential. Registered, and named by no agent.',
			input: z.object({}),
			run: async () => ({ secret: 'must-never-reach-a-transcript' })
		},
		...(shadow
			? [
					{
						name: 'list_quotes',
						description: 'A host tool with a workspace tool name.',
						input: z.object({}),
						run: async () => ({})
					}
				]
			: [])
	],
	ai: {
		chat: async (input) => {
			const offered = (input.tools ?? []).map((tool) => tool.name).join('|');
			const messages = input.messages ?? [];
			const results = messages.filter((message) => message.role === 'tool');
			if (results.length === 0) {
				return {
					text: '',
					stopReason: 'tool_use',
					toolCalls: [
						{ id: 'call_deploy', name: 'sandbox_deploy', input: { target: 'staging' } },
						{ id: 'call_secret', name: 'sandbox_secret', input: {} }
					]
				};
			}
			return {
				text:
					\`offered=\${offered}\` +
					\` deploy=\${verdict(results, 'call_deploy')}\` +
					\` secret=\${verdict(results, 'call_secret')}\`,
				stopReason: 'end'
			};
		}
	},
	messaging: messagingProviders({
		channels: [{ channel: 'email', send: async () => ({ sent: true }) }],
		transports: [{ transport: 'telegram', send: async () => ({ sent: true }) }]
	})
});
`;

async function writeWorkspace(root: string): Promise<void> {
	await cp(path.join(REPO_ROOT, 'template_workspaces/crm'), root, {
		recursive: true,
		filter: (source) => !source.includes(`${path.sep}.norbital${path.sep}build`)
	});
	await rm(path.join(root, 'node_modules'), { recursive: true, force: true });
	await linkCurrentPodWorkspaceDependencies(REPO_ROOT, root);
	await mkdir(path.join(root, 'src', 'tools'), { recursive: true });
	await writeFile(path.join(root, 'src', 'tools', '+list_quotes.tool.ts'), WORKSPACE_TOOL_SOURCE);
	await writeFile(path.join(root, 'src', 'automation', `+${AUTOMATION}.ts`), AUTOMATION_SOURCE);
	await writeFile(path.join(root, 'pod.host.ts'), HOST_SOURCE);
}

type TranscriptRow = {
	readonly seq: number;
	readonly role: string;
	readonly parts: Array<{
		readonly role: string;
		readonly content: string;
		readonly toolCallId?: string;
		readonly toolCalls?: Array<{ readonly name: string }>;
	}> | null;
};

type TranscriptAggregate = {
	readonly messages: readonly TranscriptRow[];
};

describe('Pod standalone host agent tools — E2E', () => {
	let pg: PgHarness;
	let root: string;
	let environment: NodeJS.ProcessEnv;
	let running: ChildProcessWithoutNullStreams;
	let log = '';

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
		const parent = path.join(REPO_ROOT, '.test-workspaces');
		await mkdir(parent, { recursive: true });
		root = await mkdtemp(path.join(parent, 'host-agent-tool-'));
		await writeWorkspace(root);

		const port = await freePort();
		environment = {
			...process.env,
			DATABASE_URL: pg.connectionString,
			POD_HOST: '127.0.0.1',
			POD_PORT: String(port),
			POD_ORG_ID: '55555555-5555-4555-8555-555555555555',
			POD_ORG_NAME: 'Host Agent Tool Test',
			POD_ADMIN_ID,
			POD_ADMIN_NAME: 'Sandbox Admin',
			POD_ADMIN_EMAIL: 'admin@sandbox.test',
			POD_TEMPLATE_KEY: 'crm',
			POD_TEST_HOST_RECEIPT: RECEIPT
		};
		execFileSync('node', [POD_BIN, 'build'], { cwd: root, env: environment, encoding: 'utf8' });
		execFileSync('node', [POD_BIN, 'migrate'], { cwd: root, env: environment, encoding: 'utf8' });

		running = spawn('node', [POD_BIN, 'start'], { cwd: root, env: environment, stdio: 'pipe' });
		running.stdout.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
		running.stderr.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
		await waitForOutput(running, /Pod listening at/);
	}, 300_000);

	afterAll(async () => {
		if (running) await stop(running);
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
		pg?.stop();
	});

	it('reports agentTools as a facility this host satisfies', () => {
		expect(log).toMatch(/\[pod\] facilities: .*agentTools/);
	});

	it('runs a host tool and lands its result in the transcript', async () => {
		// The queue sweeps on start and the schedule matches every minute, so the run is under way
		// before this poll begins; it waits for the loop to finish rather than for the trigger.
		const deadline = Date.now() + 90_000;
		let transcript: readonly TranscriptRow[] = [];
		for (;;) {
			const sessions = await queryTenant<TranscriptAggregate>(
				`SELECT s.messages
				   FROM chat_session s
				   JOIN automation_run r ON r.norbital_id = s.automation_run_id
				  WHERE r.automation_name = $1
				  LIMIT 1`,
				[AUTOMATION]
			);
			transcript = sessions[0]?.messages ?? [];
			if (transcript.length >= 5) break;
			if (Date.now() > deadline) {
				throw new Error(
					`Agent run never completed (${transcript.length} message(s)). Pod log:\n${log}`
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		// The prompt, the assistant turn carrying both tool calls, one result each, the answer.
		expect(transcript.map((row) => row.role)).toEqual([
			'user',
			'assistant',
			'tool',
			'tool',
			'assistant'
		]);
		expect(transcript[1]?.parts?.[0]?.toolCalls?.map((call) => call.name)).toEqual([
			'sandbox_deploy',
			'sandbox_secret'
		]);

		// The host tool's own return value, produced by a closure inside `pod.host.ts` and carried back
		// over the facility binding. Nothing in the workspace bundle knows this string.
		const deployResult = JSON.parse(transcript[2]?.parts?.[0]?.content ?? '{}') as {
			ran?: string;
			receipt?: string;
			target?: string;
			principal?: string;
		};
		expect(deployResult).toEqual({
			ran: 'host',
			receipt: RECEIPT,
			target: 'staging',
			principal: POD_ADMIN_ID
		});

		// And the tool the agent did not name is refused, though the host registered it.
		const secretResult = JSON.parse(transcript[3]?.parts?.[0]?.content ?? '{}') as {
			error?: string;
			secret?: string;
		};
		expect(secretResult.secret).toBeUndefined();
		expect(secretResult.error).toMatch(/Agent cannot execute tenant tool sandbox_secret/);

		// What the model was offered: the named host tool alongside the built-ins, and nothing else.
		// `sandbox_secret` never appears in the tool list at all — it is not merely refused on call.
		const answer = transcript[4]?.parts?.[0]?.content ?? '';
		expect(answer).toContain(
			'offered=describe_workspace|read_collection|list_skills|read_skill|spawn_subagent|sandbox_deploy'
		);
		expect(answer).not.toContain('sandbox_secret|');
		expect(answer).toContain(`deploy=ok(${RECEIPT}:staging)`);
	}, 120_000);

	/**
	 * The collision refusal, from the process that would otherwise have shadowed the workspace tool.
	 *
	 * Proved by restarting the same build, because the failure is a startup cross-reference and not a
	 * property of the workspace — the very same bundle boots fine without the switch.
	 */
	it('refuses to start when a host tool shadows a workspace tool', async () => {
		const { code, output } = await startAndExpectRefusal(root, {
			...environment,
			POD_PORT: String(await freePort()),
			POD_TEST_SHADOW: '1'
		});
		expect(code).toBe(1);
		expect(output).toContain('list_quotes');
		expect(output).toMatch(/collides with the workspace agent tool/);
		expect(output).not.toMatch(/Pod listening at/);
	}, 120_000);

	/** And the other direction: an agent naming a host tool this host does not supply. */
	it('refuses to start when an agent names a host tool this host lacks', async () => {
		const { code, output } = await startAndExpectRefusal(root, {
			...environment,
			POD_PORT: String(await freePort()),
			POD_TEST_TOOL_NAME: 'sandbox_deploy_v2'
		});
		expect(code).toBe(1);
		expect(output).toMatch(
			/names host tool "sandbox_deploy", which this host does not supply.*sandbox_deploy_v2/s
		);
	}, 120_000);
});
