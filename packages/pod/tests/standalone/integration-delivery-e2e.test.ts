import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDocker, startPostgres, type PgHarness } from '../support/pg-harness.js';

requireDocker();
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

/** More than one worker chunk: this real-PG path proves a receipt resumes rather than row-looping. */
const CATALOGUE = Array.from({ length: 101 }, (_, index) => ({
	code: `ZN-${index + 1}`,
	name: index === 0 ? 'North Yard' : index === 1 ? 'South Gantry' : `Workfront ${index + 1}`
}));
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
const WEBHOOK_INTO = 'rfis';

/** The webhook's signing secret. Like the API key, the workspace only ever names it. */
const WEBHOOK_SECRET = 'whsec-1f7a44d0';
/** The manifest's own name for the webhook binding — the key its ledger rows are filed under. */
const WEBHOOK_BINDING = 'field_reports:rfis.receive.rfi';

function signWebhook(body: string, secret: string = WEBHOOK_SECRET): string {
	return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

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
		description: 'Emits the certification types as one JSON attachment.',
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
		description: 'Turns the remote location catalogue into rows.',
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
		description: 'Turns one announced system event into a row per record it names.',
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

/**
 * The webhook half: a delivery the remote pushes, rather than one this pod went and fetched.
 *
 * `input` is on the *binding*, not the pipeline, and that placement is what the refusal test turns
 * on: it is parsed before the import pipeline runs, so a payload of the wrong shape is turned down
 * with nothing written rather than part-way through writing.
 */
const WEBHOOK_INTEGRATIONS_SOURCE = `import { z } from 'zod';
import type { Integrations } from './$types.js';

export default {
	field_reports: {
		receive: {
			rfi: {
				webhook: {
					authentication: {
						type: 'hmac-sha256',
						secret: { env: 'REPORTS_WEBHOOK_SECRET' },
						signatureHeader: 'x-reports-signature'
					},
					eventIdHeader: 'x-reports-event-id'
				},
				input: z.object({
					rfi: z.object({
						number: z.string(),
						title: z.string(),
						question: z.string()
					})
				})
			}
		}
	}
} satisfies Integrations;
`;

const WEBHOOK_PIPELINES_SOURCE = `import { z } from 'zod';
import type { Pipelines } from './$types.js';

const report = z.object({
	rfi: z.object({ number: z.string(), title: z.string(), question: z.string() })
});

export default {
	import: {
		description: 'Turns an inbound field report into an open RFI.',
		input: report,
		handler: async (ctx) => {
			const input = ctx.input as z.infer<typeof report>;
			return [
				{
					rfi_number: input.rfi.number,
					title: input.rfi.title,
					question: input.rfi.question,
					status: 'open'
				}
			];
		}
	}
} satisfies Pipelines;
`;

/** The one file naming what the host must provide. Names only — a value here would be the bug. */
const ENV_SOURCE = `import { defineEnvVars } from '@norbital-ai/pod/authoring';

export const variables = defineEnvVars({
	REGISTRY_API_KEY: { description: 'Bearer token for the certification registry API' },
	REPORTS_WEBHOOK_SECRET: { description: 'HMAC secret the field-reports webhook is signed with' }
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
	httpWebhookListener,
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
	integrationDelivery: httpIntegrationDelivery(),
	// The whole webhook configuration: a port. No route, no secret, no signature scheme is written
	// here — the routes come from the manifest and the verification happens before \`deliver\`.
	webhooks: httpWebhookListener({ host: '127.0.0.1', port: Number(env('POD_WEBHOOK_PORT')) })
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
	await writeFile(collection(WEBHOOK_INTO, '+pipelines.ts'), WEBHOOK_PIPELINES_SOURCE);
	await writeFile(collection(WEBHOOK_INTO, '+integrations.ts'), WEBHOOK_INTEGRATIONS_SOURCE);
	await writeFile(path.join(root, 'pod.host.ts'), HOST_SOURCE);
}

describe('Pod standalone integrations — E2E, both directions', () => {
	let pg: PgHarness;
	let root: string;
	let sink: Sink;
	let environment: NodeJS.ProcessEnv;
	let db: Client;
	let webhookPort: number;

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
		webhookPort = await freePort();
		environment = {
			...process.env,
			DATABASE_URL: pg.connectionString,
			POD_HOST: '127.0.0.1',
			POD_PORT: String(port),
			POD_WEBHOOK_PORT: String(webhookPort),
			REPORTS_WEBHOOK_SECRET: WEBHOOK_SECRET,
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
			await waitForOutput(running, /Reference host listening at/);
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
								row: {
									norbital_id: uuidv7(),
									certification_name: certificationName,
									certification_code: 'WAH-1'
								}
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
			await waitForOutput(running, /Reference host listening at/);
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
			const [receipt] = await db
				.query<{
					status: string;
					imported: number | null;
					materialized: number | null;
				}>(
					`SELECT status, imported, jsonb_array_length(materialized_records) AS materialized
					   FROM integration_inbound_event
					  WHERE binding_key = $1
					    AND jsonb_array_length(materialized_records) = $2`,
					['registry:site_locations.receive.catalogue', CATALOGUE.length]
				)
				.then((result) => result.rows);
			expect(receipt).toMatchObject({
				status: 'imported',
				imported: CATALOGUE.length,
				materialized: CATALOGUE.length
			});
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
			await waitForOutput(running, /Reference host listening at/);
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

	/**
	 * The push half, against the host's own socket.
	 *
	 * Everything here goes through a real HTTP request to a port `pod start` opened from the manifest,
	 * so it exercises the listener, the signature check, the ledger claim, and the import pipeline in
	 * the order a provider would hit them. The three negatives are the point: a webhook that imports
	 * the happy case and also imports a forgery, a replay, or a malformed body is worse than one that
	 * does not exist, because it looks like it works.
	 */
	describe('inbound webhooks', () => {
		let running: ChildProcessWithoutNullStreams;
		let log = '';

		/** One delivery, exactly as a provider would send it. Nothing is done for it in-process. */
		async function post(params: {
			readonly body: unknown;
			readonly eventId: string;
			readonly secret?: string;
			readonly signature?: string;
		}): Promise<number> {
			const body = JSON.stringify(params.body);
			const response = await fetch(
				`http://127.0.0.1:${webhookPort}/webhooks/field_reports/${encodeURIComponent('rfis.receive.rfi')}`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-reports-signature': params.signature ?? signWebhook(body, params.secret),
						'x-reports-event-id': params.eventId
					},
					body
				}
			);
			return response.status;
		}

		function rfi(number: string): Record<string, unknown> {
			return {
				rfi: {
					number,
					title: `Cladding detail ${number}`,
					question: 'Which fixing centres apply at the parapet?'
				}
			};
		}

		async function ledger(): Promise<Record<string, unknown>[]> {
			const result = await db.query(
				`SELECT event_id, status, imported, error FROM integration_inbound_event
				  WHERE binding_key = $1 ORDER BY norbital_created_at`,
				[WEBHOOK_BINDING]
			);
			return result.rows as Record<string, unknown>[];
		}

		beforeAll(async () => {
			running = spawn('node', [POD_BIN, 'start'], { cwd: root, env: environment, stdio: 'pipe' });
			running.stdout.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
			running.stderr.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
			await waitForOutput(running, /Reference host listening at/);
			// The endpoint is derived from the manifest, so seeing it announced is already evidence the
			// declared binding produced a route rather than a warning.
			expect(log).toContain('/webhooks/field_reports/rfis.receive.rfi');
			expect(log).not.toContain('supplies no listener');
		}, 120_000);

		afterAll(async () => {
			await stop(running);
		});

		it('imports a signed delivery through the declared receive binding', async () => {
			expect(await rows(WEBHOOK_INTO)).toHaveLength(0);
			expect(await post({ body: rfi('RFI-001'), eventId: 'evt_001' })).toBe(200);

			const landed = await waitFor(async () => {
				const found = await rows(WEBHOOK_INTO);
				return found.length > 0 ? found : undefined;
			}, `the webhook delivery to land a row. Pod log:\n${log}`);
			expect(landed).toHaveLength(1);
			expect(landed[0]?.rfi_number).toBe('RFI-001');
			// The `import` pipeline shaped it: `title` is composed here, not sent.
			expect(landed[0]?.title).toBe('Cladding detail RFI-001');
			expect(landed[0]?.status).toBe('open');

			expect(await ledger()).toEqual([
				{ event_id: 'evt_001', status: 'imported', imported: 1, error: null }
			]);
		}, 60_000);

		it('rejects a wrong signature and imports nothing', async () => {
			const before = await rows(WEBHOOK_INTO);
			// Signed with a secret this host does not hold — the shape of a forgery, or of a provider
			// whose key was rotated without telling anyone.
			expect(
				await post({ body: rfi('RFI-FORGED'), eventId: 'evt_forged', secret: 'not-the-secret' })
			).toBe(401);
			// And with no signature at all.
			expect(
				await post({ body: rfi('RFI-UNSIGNED'), eventId: 'evt_unsigned', signature: '' })
			).toBe(401);

			await new Promise((resolve) => setTimeout(resolve, 1000));
			expect(await rows(WEBHOOK_INTO)).toHaveLength(before.length);
			// Nothing was claimed either: a rejected delivery never reached the runtime, so it left no
			// trace an operator could mistake for a handled event.
			expect((await ledger()).map((row) => row.event_id)).toEqual(['evt_001']);
		}, 60_000);

		it('imports nothing the second time an event id is delivered', async () => {
			const before = await rows(WEBHOOK_INTO);
			// A different body under the *same* event id. If the ledger were not doing the work, this
			// would land a second row with a different number and the assertion below would say so —
			// re-sending identical bytes would prove nothing an idempotent pipeline could not fake.
			expect(await post({ body: rfi('RFI-REPLAY'), eventId: 'evt_001' })).toBe(200);

			await new Promise((resolve) => setTimeout(resolve, 1000));
			const after = await rows(WEBHOOK_INTO);
			expect(after).toHaveLength(before.length);
			expect(after.map((row) => row.rfi_number)).not.toContain('RFI-REPLAY');
			// One ledger row, still the first one, still recording one import.
			expect(await ledger()).toEqual([
				{ event_id: 'evt_001', status: 'imported', imported: 1, error: null }
			]);
		}, 60_000);

		it('refuses a payload the binding refuses, rather than importing part of it', async () => {
			const before = await rows(WEBHOOK_INTO);
			// Correctly signed, correctly new — and the wrong shape. `question` is missing, which the
			// binding's `input` schema requires.
			expect(
				await post({
					body: { rfi: { number: 'RFI-BAD', title: 'No question' } },
					eventId: 'evt_bad'
				})
			).toBe(422);

			await new Promise((resolve) => setTimeout(resolve, 1000));
			expect(await rows(WEBHOOK_INTO)).toHaveLength(before.length);
			const rows_ = await ledger();
			const failed = rows_.find((row) => row.event_id === 'evt_bad');
			// The refusal is recorded, imported nothing, and says why: it was claimed before the import
			// ran, which is what makes the record possible at all.
			expect(failed?.status).toBe('failed');
			expect(failed?.imported).toBeNull();
			expect(String(failed?.error)).toContain('question');
		}, 60_000);
	});
});
