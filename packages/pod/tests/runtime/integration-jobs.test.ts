import { describe, expect, it } from 'vitest';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { workspaceJobs } from '../../src/host/jobs.js';
import { httpIntegrationDelivery } from '../../src/host/integration-http.js';

const OUTBOX_ROW = {
	norbital_id: '11111111-1111-4111-8111-111111111111',
	integration_name: 'registry',
	binding_name: 'quotes.send.upsert',
	collection_name: 'quotes',
	record_id: '22222222-2222-4222-8222-222222222222',
	action: 'create',
	payload: { norbital_id: '22222222-2222-4222-8222-222222222222' },
	attempts: 0
};

function manifest(definition: Record<string, unknown>): NorbitalManifest {
	return {
		version: 1,
		collections: {},
		relationships: {},
		automations: {},
		integrations: { registry: { name: 'registry', definition } }
	} as NorbitalManifest;
}

const API_DESTINATION = {
	collection: 'quotes',
	pipeline: 'export',
	trigger: 'collection-events',
	destination: {
		type: 'api',
		url: 'https://saas.example/v1/quotes',
		method: 'POST',
		headers: { 'x-source': 'pod' },
		secretHeaders: { authorization: { type: 'secret', name: 'REGISTRY_KEY', prefix: 'Bearer ' } }
	}
};

const PULL_ORIGIN = {
	collection: 'quotes',
	pipeline: 'import',
	origin: {
		type: 'api-pull',
		schedule: '*/5 * * * *',
		url: 'https://saas.example/v1/quotes',
		secretHeaders: { authorization: { type: 'secret', name: 'REGISTRY_KEY', prefix: 'Bearer ' } },
		cursorQuery: 'since',
		nextCursorHeader: 'x-next-cursor'
	}
};

/** Records every dispatch so the order and shape of the host-command traffic can be asserted. */
function recordingDispatch(answers: (request: Record<string, unknown>) => unknown) {
	const seen: Record<string, unknown>[] = [];
	return {
		seen,
		dispatch: async (body: unknown) => {
			const request = body as Record<string, unknown>;
			seen.push(request);
			return answers(request);
		}
	};
}

describe('integration jobs', () => {
	it('builds one pull job per api-pull binding, on its own declared schedule', () => {
		const jobs = workspaceJobs({
			manifest: manifest({ inbound: { 'quotes.receive.catalogue': PULL_ORIGIN } }),
			dispatch: async () => undefined,
			organizationId: 'org-1'
		});
		expect(jobs.map((job) => [job.name, job.schedule])).toEqual([
			['pod:integration-import', 'continuous'],
			['pod:agent-conversation-titles', 'continuous'],
			['pod:integration-pull:registry:quotes.receive.catalogue', '*/5 * * * *']
		]);
	});

	it('runs one bounded durable import step per continuous-worker invocation', async () => {
		const { seen, dispatch } = recordingDispatch(() => undefined);
		const jobs = workspaceJobs({
			manifest: manifest({}),
			dispatch,
			organizationId: 'org-1'
		});
		await jobs.find((job) => job.name === 'pod:integration-import')!.run();
		expect(seen).toEqual([{ kind: 'integration-import', action: 'run' }]);
	});

	/**
	 * A pull needs no host provider at all — only the schedule the workspace declared. Gating it on
	 * `integrationDelivery` would have made an inbound binding depend on the outbound facility, which
	 * is roughly how it went unnoticed that nothing ever drove one.
	 */
	it('drives a pull with no integrationDelivery configured', async () => {
		const { seen, dispatch } = recordingDispatch((request) =>
			request.kind === 'integration-cursor' && request.action === 'read' ? { cursor: 'page-1' } : {}
		);
		const requests: { url: string; authorization: string | null }[] = [];
		const jobs = workspaceJobs({
			manifest: manifest({ inbound: { 'quotes.receive.catalogue': PULL_ORIGIN } }),
			dispatch,
			organizationId: 'org-1',
			secrets: (name) => (name === 'REGISTRY_KEY' ? 'live-value' : undefined),
			fetch: async (input, init) => {
				requests.push({
					url: String(input),
					authorization: new Headers(init?.headers).get('authorization')
				});
				return new Response(JSON.stringify({ rows: [] }), {
					headers: { 'content-type': 'application/json', 'x-next-cursor': 'page-2' }
				});
			}
		});
		await jobs.find((job) => job.name.includes('integration-pull'))!.run();

		// The stored cursor becomes the declared query parameter, and the credential is resolved here —
		// the workspace only ever named it.
		expect(requests).toEqual([
			{ url: 'https://saas.example/v1/quotes?since=page-1', authorization: 'Bearer live-value' }
		]);
		expect(seen.map((request) => [request.kind, request.action ?? request.direction])).toEqual([
			['integration-cursor', 'read'],
			['integration', 'receive'],
			['integration-cursor', 'write']
		]);
		// A retry of this cursor names the same durable receipt; provider payload shape does not decide
		// whether a pull page is new.
		expect(seen[1]?.eventId).toMatch(/^pull:[0-9a-f]{64}$/);
		// Advanced only after the rows landed, and to what the remote said comes next.
		expect(seen[2]).toMatchObject({ cursor: 'page-2', error: null });
	});

	/** A failed pull must not advance the cursor, or the page it never imported is skipped forever. */
	it('leaves the cursor where it was when the remote refuses', async () => {
		const { seen, dispatch } = recordingDispatch((request) =>
			request.kind === 'integration-cursor' && request.action === 'read' ? { cursor: 'page-1' } : {}
		);
		const jobs = workspaceJobs({
			manifest: manifest({ inbound: { 'quotes.receive.catalogue': PULL_ORIGIN } }),
			dispatch,
			organizationId: 'org-1',
			log: () => {},
			secrets: () => 'live-value',
			fetch: async () => new Response('nope', { status: 503 })
		});
		await expect(jobs.find((job) => job.name.includes('integration-pull'))!.run()).rejects.toThrow(
			/refused/
		);
		expect(seen.at(-1)).toMatchObject({ action: 'write', cursor: 'page-1' });
		expect(String(seen.at(-1)?.error)).toMatch(/503/);
	});

	/** A declared secret the host cannot supply fails naming the key, not as a far-away 401. */
	it('refuses to call without a secret it was told to send', async () => {
		const jobs = workspaceJobs({
			manifest: manifest({ inbound: { 'quotes.receive.catalogue': PULL_ORIGIN } }),
			dispatch: async () => ({ cursor: null }),
			organizationId: 'org-1',
			log: () => {},
			secrets: () => undefined,
			fetch: async () => new Response('{}')
		});
		await expect(jobs.find((job) => job.name.includes('integration-pull'))!.run()).rejects.toThrow(
			/REGISTRY_KEY/
		);
	});

	/**
	 * A system event is this workspace talking to itself. Handing it to `integrationDelivery` asked a
	 * host to POST an event it had no URL for, and the matching `receive` binding never ran.
	 */
	it('routes a system-event destination back into the workspace instead of to the host', async () => {
		let claimed = false;
		const seen: Record<string, unknown>[] = [];
		let deliveries = 0;
		const jobs = workspaceJobs({
			manifest: manifest({
				outbound: {
					'quotes.send.announce': {
						collection: 'quotes',
						pipeline: 'export',
						trigger: 'collection-events',
						destination: { type: 'system-event', event: 'quote.created' }
					}
				}
			}),
			organizationId: 'org-1',
			integrationDelivery: async () => {
				deliveries += 1;
			},
			async dispatch(body) {
				const request = body as Record<string, unknown>;
				seen.push(request);
				if (request.kind === 'outbox' && request.action === 'claim' && !claimed) {
					claimed = true;
					return [{ ...OUTBOX_ROW, binding_name: 'quotes.send.announce' }];
				}
				if (request.kind === 'integration') return { shaped: true };
				return undefined;
			}
		});
		await jobs.find((job) => job.name === 'pod:integration-outbox')!.run();

		expect(deliveries).toBe(0);
		const event = seen.find((request) => request.kind === 'system-event');
		expect(event).toMatchObject({ event: 'quote.created', payload: { shaped: true } });
		// The row still settles: a delivery that stayed inside the pod is still a delivery.
		expect(seen.at(-1)).toMatchObject({ kind: 'outbox', action: 'delivered' });
	});

	it('hands the declared destination to the host with the outbound message', async () => {
		let claimed = false;
		const delivered: unknown[] = [];
		const jobs = workspaceJobs({
			manifest: manifest({ outbound: { 'quotes.send.upsert': API_DESTINATION } }),
			organizationId: 'org-1',
			integrationDelivery: async (message) => {
				delivered.push(message.destination);
			},
			async dispatch(body) {
				const request = body as Record<string, unknown>;
				if (request.kind === 'outbox' && request.action === 'claim' && !claimed) {
					claimed = true;
					return [OUTBOX_ROW];
				}
				return { shaped: true };
			}
		});
		await jobs.find((job) => job.name === 'pod:integration-outbox')!.run();
		expect(delivered).toEqual([API_DESTINATION.destination]);
	});
});

describe('httpIntegrationDelivery', () => {
	const message = {
		integrationName: 'registry',
		bindingName: 'quotes.send.upsert',
		collectionName: 'quotes',
		recordId: OUTBOX_ROW.record_id,
		action: 'create',
		payload: { shaped: true },
		destination: API_DESTINATION.destination
	} as Parameters<ReturnType<typeof httpIntegrationDelivery>>[0];

	it('performs the declared request with the credential resolved here', async () => {
		let seen: { url: string; method?: string; headers: Headers; body: string } | undefined;
		const deliver = httpIntegrationDelivery({
			secrets: (name) => (name === 'REGISTRY_KEY' ? 'live-value' : undefined),
			fetch: async (input, init) => {
				seen = {
					url: String(input),
					method: init?.method,
					headers: new Headers(init?.headers),
					body: String(init?.body)
				};
				return new Response(null, { status: 204 });
			}
		});
		await deliver(message);
		expect(seen?.url).toBe('https://saas.example/v1/quotes');
		expect(seen?.method).toBe('POST');
		expect(seen?.headers.get('authorization')).toBe('Bearer live-value');
		expect(seen?.headers.get('x-source')).toBe('pod');
		expect(seen?.body).toBe('{"shaped":true}');
	});

	/** A refusal has to throw, or the outbox marks a message delivered that never arrived. */
	it('throws on a refusal, naming the endpoint and quoting the answer', async () => {
		const deliver = httpIntegrationDelivery({
			secrets: () => 'live-value',
			fetch: async () => new Response('quota exceeded', { status: 429 })
		});
		await expect(deliver(message)).rejects.toThrow(/saas\.example.*429.*quota exceeded/s);
	});
});
