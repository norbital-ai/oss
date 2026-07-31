import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable, startPostgres, type PgHarness } from '../support/pg-harness.js';

const hasDocker = dockerAvailable();
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const POD_BIN = path.join(REPO_ROOT, 'packages/pod/build/bin/invocation/index.js');

/** The credential the workspace only ever names. The host resolves it; the isolate never sees it. */
const API_KEY = 'registry-secret-b3f1';

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

/** One request the stand-in SaaS received, kept whole so the credential can be asserted on. */
type ReceivedRequest = {
	readonly method: string;
	readonly url: string;
	readonly authorization: string | undefined;
	readonly body: { readonly kind?: string; readonly records?: readonly unknown[] };
};

type Sink = {
	readonly url: string;
	readonly delivered: ReceivedRequest[];
	readonly pulls: string[];
	close(): Promise<void>;
};

/** Two rows the remote holds, which a pull is expected to bring across as `site_locations`. */
const CATALOGUE = [
	{ code: 'ZN-1', name: 'North Yard' },
	{ code: 'ZN-2', name: 'South Gantry' }
];
const CATALOGUE_CURSOR = 'page-2';

/**
 * A stand-in for the external SaaS, on a real socket.
 *
 * Both directions run through it, which is the point: an in-process spy would pass whether or not
 * anything left the Pod process. `POST /records` is where the workspace's outbound binding delivers;
 * `GET /catalogue` is what its scheduled pull reads.
 *
 * The catalogue is cursor-aware and answers an already-seen cursor with nothing. That is what makes
 * the second boot meaningful: if the cursor were held in the job's closure rather than in the
 * database, a restarted pod would ask without one and be handed the same two rows again.
 */
async function startSink(): Promise<Sink> {
	const delivered: ReceivedRequest[] = [];
	const pulls: string[] = [];
	const server: Server = createHttpServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://sink.invalid');
		const authorization = request.headers.authorization;
		if (request.method === 'GET' && url.pathname === '/catalogue') {
			pulls.push(request.url ?? '');
			if (authorization !== `Bearer ${API_KEY}`) {
				response.statusCode = 401;
				response.end();
				return;
			}
			const cursor = url.searchParams.get('since');
			response.setHeader('content-type', 'application/json');
			response.setHeader('x-next-cursor', CATALOGUE_CURSOR);
			response.end(JSON.stringify({ locations: cursor === CATALOGUE_CURSOR ? [] : CATALOGUE }));
			return;
		}
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			try {
				delivered.push({
					method: request.method ?? '',
					url: request.url ?? '',
					authorization,
					body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as ReceivedRequest['body']
				});
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
		delivered,
		pulls,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}

async function waitFor<T>(
	produce: () => Promise<T | undefined> | (T | undefined),
	describeFailure: string,
	timeoutMs = 60_000
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await produce();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describeFailure}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

const SENDING = 'certification_types';
const PULLED_INTO = 'site_locations';
const EVENT_INTO = 'defects';

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
 * An export pipeline for the sending collection.
 *
 * The outbound path runs the collection's *export* pipeline first and hands its manifest to the
 * binding's `transform`, so a collection with no export pipeline can never send.
 */
const SEND_PIPELINES_SOURCE = `import type { Pipelines } from './$types.js';

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
 * The import half: whatever the remote returned becomes rows, or it does not arrive.
 *
 * `ctx.input` is cast rather than inferred because `Pipelines` erases the import schema's output
 * type — `satisfies` cannot thread one property's generic into a sibling's parameter. The zod schema
 * is still what runs, so the cast restates a shape the runtime has already enforced.
 */
const PULL_PIPELINES_SOURCE = `import { z } from 'zod';
import type { Pipelines } from './$types.js';

const catalogue = z.object({
	locations: z.array(z.object({ code: z.string(), name: z.string() }))
});

export default {
	import: {
		input: catalogue,
		handler: async (ctx) => {
			const input = ctx.input as z.infer<typeof catalogue>;
			return input.locations.map((location) => ({
				location_code: location.code,
				location_name: location.name
			}));
		}
	}
} satisfies Pipelines;
`;

/** The system-event half: one announcement becomes one row. */
const EVENT_PIPELINES_SOURCE = `import { z } from 'zod';
import type { Pipelines } from './$types.js';

const announcement = z.object({
	event: z.string(),
	payload: z.object({ records: z.array(z.object({ name: z.string() })) })
});

export default {
	import: {
		input: announcement,
		handler: async (ctx) => {
			const input = ctx.input as z.infer<typeof announcement>;
			return input.payload.records.map((record) => ({
				title: \`announced: \${record.name}\`,
				category: input.event
			}));
		}
	}
} satisfies Pipelines;
`;

/**
 * The connection, written where the doc says to write it.
 *
 * Two collections name the same integration and repeat the same `defineConnection`. That used to be
 * refused — connections were compared by object identity, so sharing one across files was impossible
 * without a registry the compiler never emitted. The credential is a *reference*: `REGISTRY_API_KEY`
 * appears in the manifest, its value never does.
 */
function connectionSource(baseUrl: string): string {
	return `const registry = defineConnection({
	baseUrl: ${JSON.stringify(baseUrl)},
	authentication: { type: 'bearer', token: { env: 'REGISTRY_API_KEY' } }
});`;
}

function sendIntegrationsSource(baseUrl: string): string {
	return `import { defineConnection } from '@norbital-ai/pod/authoring';
import type { Integrations } from './$types.js';

${connectionSource(baseUrl)}

export default {
	registry: {
		connection: registry,
		send: {
			upsert: {
				request: { method: 'POST', path: '/records' },
				on: 'create',
				transform: ({ output }) => ({
					kind: 'certification',
					records: output[0]?.attachments[0]?.content
				})
			}
		}
	},
	internal: {
		send: {
			announce: {
				systemEvent: { event: 'certification_type.created' },
				on: 'create',
				transform: ({ output }) => ({
					kind: 'announcement',
					records: output[0]?.attachments[0]?.content
				})
			}
		}
	}
} satisfies Integrations;
`;
}

function pullIntegrationsSource(baseUrl: string): string {
	return `import { defineConnection } from '@norbital-ai/pod/authoring';
import type { Integrations } from './$types.js';

${connectionSource(baseUrl)}

export default {
	registry: {
		connection: registry,
		receive: {
			catalogue: {
				pull: {
					schedule: '* * * * *',
					path: '/catalogue',
					cursorQuery: 'since',
					nextCursorHeader: 'x-next-cursor'
				}
			}
		}
	}
} satisfies Integrations;
`;
}

const EVENT_INTEGRATIONS_SOURCE = `import type { Integrations } from './$types.js';

export default {
	internal: {
		receive: {
			record: { systemEvent: { event: 'certification_type.created' } }
		}
	}
} satisfies Integrations;
`;

/** The one file naming what the host must provide. Names only — a value here would be the bug. */
const ENV_SOURCE = `import { defineEnv } from '@norbital-ai/pod/authoring';

export default defineEnv({
	private: {
		REGISTRY_API_KEY: { description: 'Bearer token for the certification registry API' }
	}
});
`;

/**
 * A host that drains the outbox and honours the declared destination.
 *
 * `httpIntegrationDelivery()` is the whole delivery configuration: no URL, no header, no credential
 * is written here, because all three are in the workspace's own declaration and the secret is read
 * from this process's environment at call time.
 */
const HOST_SOURCE = `import {
	consoleMessaging,
	definePodHost,
	devIdentity,
	env,
	httpIntegrationDelivery,
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
	messaging: consoleMessaging({ channels: ['email'] }),
	queue: intervalQueue({ intervalMs: 1000 }),
	integrationDelivery: httpIntegrationDelivery()
});
`;

async function writeWorkspace(root: string, sinkUrl: string): Promise<void> {
	await cp(path.join(REPO_ROOT, 'template_workspaces/construction'), root, {
		recursive: true,
		filter: (source) => !source.includes(`${path.sep}.norbital${path.sep}build`)
	});
	const collection = (name: string, file: string) => path.join(root, 'src/collections', name, file);
	await writeFile(path.join(root, 'src/+env.ts'), ENV_SOURCE);
	await writeFile(collection(SENDING, '+hooks.ts'), HOOKS_SOURCE);
	await writeFile(collection(SENDING, '+pipelines.ts'), SEND_PIPELINES_SOURCE);
	await writeFile(collection(SENDING, '+integrations.ts'), sendIntegrationsSource(sinkUrl));
	await writeFile(collection(PULLED_INTO, '+pipelines.ts'), PULL_PIPELINES_SOURCE);
	await writeFile(collection(PULLED_INTO, '+integrations.ts'), pullIntegrationsSource(sinkUrl));
	await writeFile(collection(EVENT_INTO, '+pipelines.ts'), EVENT_PIPELINES_SOURCE);
	await writeFile(collection(EVENT_INTO, '+integrations.ts'), EVENT_INTEGRATIONS_SOURCE);
	await writeFile(path.join(root, 'pod.host.ts'), HOST_SOURCE);
}

describe.skipIf(!hasDocker)('Pod standalone integrations — E2E, both directions', () => {
	let pg: PgHarness;
	let root: string;
	let sink: Sink;
	let environment: NodeJS.ProcessEnv;
	let db: Client;

	async function rows(collection: string): Promise<Record<string, unknown>[]> {
		const result = await db.query(`SELECT * FROM "${collection}" ORDER BY norbital_created_at`);
		return result.rows as Record<string, unknown>[];
	}

	beforeAll(async () => {
		pg = await startPostgres();
		sink = await startSink();
		const parent = path.join(REPO_ROOT, '.test-workspaces');
		await mkdir(parent, { recursive: true });
		root = await mkdtemp(path.join(parent, 'integration-delivery-'));
		await writeWorkspace(root, sink.url);

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
			REGISTRY_API_KEY: API_KEY
		};
		execFileSync('node', [POD_BIN, 'build'], { cwd: root, env: environment, stdio: 'ignore' });
		execFileSync('node', [POD_BIN, 'migrate'], { cwd: root, env: environment, stdio: 'ignore' });
		db = new Client({ connectionString: pg.connectionString });
		await db.connect();
	}, 300_000);

	afterAll(async () => {
		await db?.end().catch(() => undefined);
		await sink?.close();
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
		pg?.stop();
	});

	it('sends a created record to the declared endpoint, transformed and authenticated', async () => {
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
			expect(sink.delivered).toHaveLength(0);

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
								collection: SENDING,
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

			const request = await waitFor(
				() => sink.delivered.find((entry) => entry.url === '/records'),
				`the outbound delivery for ${recordId}. Pod log:\n${log}`
			);

			// The declared request line, not a shape the host invented.
			expect(request.method).toBe('POST');
			// The credential the workspace only ever named. It reached the wire because the *host*
			// resolved `REGISTRY_API_KEY`; nothing in the workspace ever held the value.
			expect(request.authorization).toBe(`Bearer ${API_KEY}`);
			// The binding's `transform` shape, not the raw row: proof the outbound pipeline ran rather
			// than the outbox row being shipped verbatim.
			expect(request.body.kind).toBe('certification');
			expect(request.body.records).toEqual([
				{ id: recordId, name: certificationName, code: 'WAH-1' }
			]);

			// Same create, second binding: a `systemEvent` destination stays inside the pod and reaches
			// the `receive` binding waiting on it, which lands a row of its own.
			const announced = await waitFor(async () => {
				const found = await rows(EVENT_INTO);
				return found.length > 0 ? found : undefined;
			}, `the system event to reach its receive binding. Pod log:\n${log}`);
			expect(announced).toHaveLength(1);
			expect(announced[0]?.title).toBe(`announced: ${certificationName}`);
			expect(announced[0]?.category).toBe('certification_type.created');
		} finally {
			await stop(running);
		}
	}, 180_000);

	it('pulls the remote catalogue on its schedule and lands the rows in a collection', async () => {
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
			const landed = await waitFor(async () => {
				const found = await rows(PULLED_INTO);
				return found.length >= CATALOGUE.length ? found : undefined;
			}, `the scheduled pull to land rows. Pod log:\n${log}`);

			expect(landed.map((row) => [row.location_code, row.location_name])).toEqual(
				CATALOGUE.map((entry) => [entry.code, entry.name])
			);
			// The first pull asked without a cursor: there was nothing yet to resume from.
			expect(sink.pulls[0]).toBe('/catalogue');
			const [cursor] = await db
				.query<{ cursor: string | null }>(
					`SELECT cursor FROM integration_cursor WHERE binding_key = $1`,
					['registry:site_locations.receive.catalogue']
				)
				.then((result) => result.rows);
			expect(cursor?.cursor).toBe(CATALOGUE_CURSOR);
		} finally {
			await stop(running);
		}
	}, 180_000);

	it('resumes from the stored cursor and does not redeliver a settled outbox row', async () => {
		const deliveredBefore = sink.delivered.length;
		expect(deliveredBefore).toBeGreaterThan(0);
		const pullsBefore = sink.pulls.length;
		const running = spawn('node', [POD_BIN, 'start'], {
			cwd: root,
			env: environment,
			stdio: 'pipe'
		});
		try {
			await waitForOutput(running, /Pod listening at/);
			// Enough sweeps at the configured 1s interval for a claimable row to be re-sent and for the
			// pull to run again in this fresh process.
			await waitFor(
				() => (sink.pulls.length > pullsBefore ? sink.pulls.length : undefined),
				'the restarted process to pull again'
			);
			await new Promise((resolve) => setTimeout(resolve, 3000));

			// A settled outbox row is not resent.
			expect(sink.delivered).toHaveLength(deliveredBefore);
			// The cursor came from the database, not from a closure that died with the last process —
			// so the remote was asked for what comes *after* the page already imported.
			expect(sink.pulls.at(-1)).toBe(`/catalogue?since=${CATALOGUE_CURSOR}`);
			expect(await rows(PULLED_INTO)).toHaveLength(CATALOGUE.length);
		} finally {
			await stop(running);
		}
	}, 180_000);
});
