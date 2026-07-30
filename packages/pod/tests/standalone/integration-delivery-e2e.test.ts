import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable, startPostgres, type PgHarness } from '../support/pg-harness.js';

const hasDocker = dockerAvailable();
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const POD_BIN = path.join(REPO_ROOT, 'packages/pod/build/bin/invocation/index.js');

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

/** The message shape `HostIntegrationDelivery` receives, as this test's sink records it. */
type DeliveredMessage = {
	readonly integrationName: string;
	readonly bindingName: string;
	readonly collectionName: string;
	readonly recordId: string;
	readonly action: string;
	readonly payload: { readonly kind?: string; readonly records?: readonly unknown[] };
};

type Sink = {
	readonly url: string;
	readonly received: DeliveredMessage[];
	close(): Promise<void>;
};

/**
 * A real HTTP endpoint for the workspace to be delivered to.
 *
 * The delivery has to leave the Pod process over a socket for this to prove anything: an in-process
 * spy would pass whether or not the runner actually hands the outbox to the configured host
 * function. `pod.host.ts` below POSTs here, so a received body is proof the whole chain ran.
 */
async function startSink(): Promise<Sink> {
	const received: DeliveredMessage[] = [];
	const server: Server = createHttpServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			try {
				received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as DeliveredMessage);
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
		received,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}

async function waitFor<T>(
	produce: () => T | undefined,
	describeFailure: string,
	timeoutMs = 60_000
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = produce();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describeFailure}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

const COLLECTION = 'certification_types';

/**
 * Make the collection writable.
 *
 * A collection is mutable only where it declares the mutation — `allowsMutation` reads the presence
 * of the section, not its contents — and the construction template declares none for this one. An
 * empty `create` section is the whole declaration; there is nothing to hook.
 */
const HOOKS_SOURCE = `import type { Hooks } from './$types.js';

export default { create: {} } satisfies Hooks;
`;

/**
 * An export pipeline for the integrated collection.
 *
 * The outbound path runs the collection's *export* pipeline first and hands its manifest to the
 * binding's `transform`, so a collection with no export pipeline can never send. The construction
 * template ships none, so the test workspace adds one.
 */
const PIPELINES_SOURCE = `import type { Pipelines } from './$types.js';

export default {
	export: {
		handler: async (ctx) => [
			{
				label: 'certification_types',
				attachments: [
					{
						name: 'certification_types.json',
						contentType: 'JSON',
						content: ctx.records.map((record) => ({
							id: record.norbital_id,
							name: record.certification_name,
							code: record.certification_code
						}))
					}
				]
			}
		]
	}
} satisfies Pipelines;
`;

/**
 * One outbound binding: every created certification type is sent, transformed.
 *
 * The destination is a system event rather than an HTTP request because a filesystem workspace
 * currently has no way to declare the `connection` an HTTP request destination requires:
 * `registerIntegrations` accepts a connection only when it is also present in `defineWorkspace`'s
 * `connections` input, and the compiler emits no such input. That does not weaken what is under
 * test — the destination is manifest metadata, `IntegrationDeliveryMessage` never carries it, and
 * every claimed outbox row reaches the host's `integrationDelivery` the same way regardless.
 */
const INTEGRATIONS_SOURCE = `import type { Integrations } from './$types.js';

export default {
	registry: {
		send: {
			upsert: {
				systemEvent: { event: 'certification_type.created' },
				on: 'create',
				transform: ({ output }) => ({
					kind: 'certification',
					records: output[0]?.attachments[0]?.content
				})
			}
		}
	}
} satisfies Integrations;
`;

/** A host that supplies the queue that drains the outbox and the delivery function that ships it. */
const HOST_SOURCE = `import {
	consoleNotifications,
	definePodHost,
	devIdentity,
	env,
	intervalQueue,
	localFileStorage,
	postgresDb
} from '@norbital-ai/pod/host';

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
	notifications: consoleNotifications('email'),
	queue: intervalQueue({ intervalMs: 1000 }),
	integrationDelivery: async (message) => {
		const response = await fetch(\`\${env('POD_TEST_SINK_URL')}/delivered\`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(message)
		});
		if (!response.ok) throw new Error(\`Delivery endpoint answered \${response.status}\`);
	}
});
`;

async function writeWorkspace(root: string): Promise<void> {
	await cp(path.join(REPO_ROOT, 'template_workspaces/construction'), root, {
		recursive: true,
		filter: (source) => !source.includes(`${path.sep}.norbital${path.sep}build`)
	});
	const collectionDirectory = path.join(root, 'src/collections', COLLECTION);
	await writeFile(path.join(collectionDirectory, '+hooks.ts'), HOOKS_SOURCE);
	await writeFile(path.join(collectionDirectory, '+pipelines.ts'), PIPELINES_SOURCE);
	await writeFile(path.join(collectionDirectory, '+integrations.ts'), INTEGRATIONS_SOURCE);
	await writeFile(path.join(root, 'pod.host.ts'), HOST_SOURCE);
}

describe.skipIf(!hasDocker)('Pod standalone integration delivery — E2E', () => {
	let pg: PgHarness;
	let root: string;
	let sink: Sink;
	let environment: NodeJS.ProcessEnv;

	beforeAll(async () => {
		pg = await startPostgres();
		sink = await startSink();
		const parent = path.join(REPO_ROOT, '.test-workspaces');
		await mkdir(parent, { recursive: true });
		root = await mkdtemp(path.join(parent, 'integration-delivery-'));
		await writeWorkspace(root);

		const port = await freePort();
		environment = {
			...process.env,
			DATABASE_URL: pg.connectionString,
			POD_HOST: '127.0.0.1',
			POD_PORT: String(port),
			POD_ORG_ID: '11111111-1111-4111-8111-111111111111',
			POD_ORG_NAME: 'Integration Delivery Test',
			POD_ADMIN_ID: '22222222-2222-4222-8222-222222222222',
			POD_ADMIN_NAME: 'Integration Admin',
			POD_ADMIN_EMAIL: 'admin@integration.test',
			POD_TEMPLATE_KEY: 'construction',
			POD_TEST_SINK_URL: sink.url
		};
		execFileSync('node', [POD_BIN, 'build'], { cwd: root, env: environment, stdio: 'ignore' });
		execFileSync('node', [POD_BIN, 'migrate'], { cwd: root, env: environment, stdio: 'ignore' });
	}, 300_000);

	afterAll(async () => {
		await sink?.close();
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
		pg?.stop();
	});

	it('sends a created record to the host delivery endpoint, transformed', async () => {
		const running = spawn('node', [POD_BIN, 'start'], {
			cwd: root,
			env: environment,
			stdio: 'pipe'
		});
		let log = '';
		running.stdout.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
		running.stderr.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
		try {
			await waitForOutput(running, /Pod listening at/);
			expect(sink.received).toHaveLength(0);

			const certificationName = `Working at Heights ${Date.now()}`;
			const mutation = await fetch(
				`http://127.0.0.1:${environment.POD_PORT}/_runtime/sync/mutate`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						mutations: [
							{
								clientId: 'integration-delivery-test',
								collection: COLLECTION,
								action: 'create',
								row: { certification_name: certificationName, certification_code: 'WAH-1' }
							}
						]
					})
				}
			);
			expect(mutation.status).toBe(200);
			const mutationBody = (await mutation.json()) as {
				results?: readonly { status?: string; serverId?: string; reason?: string }[];
			};
			const result = mutationBody.results?.[0];
			expect(result?.status, `mutation rejected: ${JSON.stringify(mutationBody)}`).toBe(
				'confirmed'
			);
			const recordId = result?.serverId;
			expect(typeof recordId).toBe('string');

			const delivered = await waitFor(
				() => sink.received.find((message) => message.recordId === recordId),
				`integration delivery for ${recordId}. Pod log:\n${log}`
			);

			expect(delivered.integrationName).toBe('registry');
			expect(delivered.bindingName).toBe(`${COLLECTION}.send.upsert`);
			expect(delivered.collectionName).toBe(COLLECTION);
			expect(delivered.action).toBe('create');
			// The binding's `transform` shape, not the raw row: proof the outbound pipeline ran rather
			// than the outbox row being shipped verbatim.
			expect(delivered.payload.kind).toBe('certification');
			expect(delivered.payload.records).toEqual([
				{ id: recordId, name: certificationName, code: 'WAH-1' }
			]);
		} finally {
			await stop(running);
		}
	}, 180_000);

	it('marks the delivered outbox row rather than redelivering it', async () => {
		const before = sink.received.length;
		expect(before).toBeGreaterThan(0);
		const running = spawn('node', [POD_BIN, 'start'], {
			cwd: root,
			env: environment,
			stdio: 'pipe'
		});
		try {
			await waitForOutput(running, /Pod listening at/);
			// Three drain sweeps at the configured 1s interval; a row left claimable would be re-sent.
			await new Promise((resolve) => setTimeout(resolve, 4000));
			expect(sink.received).toHaveLength(before);
		} finally {
			await stop(running);
		}
	}, 120_000);
});
