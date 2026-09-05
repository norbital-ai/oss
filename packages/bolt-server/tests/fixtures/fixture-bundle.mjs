export const protocolVersion = 8;

export const manifest = {
	protocolVersion: 8,
	artifactId: 'bolt-server-fixture',
	artifactVersion: 'fixture-1',
	schemaFingerprint: 'fixture-schema',
	schemaPlan: { fingerprint: 'fixture-schema', steps: [] },
	requiredFacilities: [],
	// The bytes live in `./assets/<sha256>` beside this module, exactly as `bolt sync` writes them.
	browserAssets: [
		{
			path: 'index.html',
			contentType: 'text/plain; charset=utf-8',
			sha256: '4290f01183a1ad0c3b7ba37eb33d0a307d414b04c98acf67307d881192bb118d',
			byteLength: 12
		}
	],
	// Declared for the workspace's own runtime and reachable only through the guest's asset bridge.
	// It is here so the suite can prove there is no HTTP route that answers for it.
	serverAssets: [
		{
			path: 'node_modules/pdq-wasm/wasm/pdq.wasm',
			contentType: 'application/wasm',
			sha256: 'd3b313ed56aa21fe4420bf0439db6e687affdbc22a3a4ef85f626d3f10c43012',
			byteLength: 12
		}
	],
	// Present and empty, not absent: the manifest schema requires the field so a host can tell a
	// workspace that declares no integrations from an artifact built before manifests carried them.
	integrations: []
};

const ok = (response) => ({ _tag: 'Success', response });

/** Last `sync.advance` this fixture saw, so the suite can prove the host signed it. */
let lastAdvance = null;
let notePayload = '';

export const dispatch = async (invocation, _facilities, signal) => {
	if (invocation._tag === 'Command') {
		if (invocation.command === 'test.unauthenticated') {
			return {
				_tag: 'Failure',
				error: {
					code: 'unauthorized',
					message: 'Missing command credential',
					retryable: false,
					outcome: 'known',
					httpStatus: 401
				}
			};
		}
		if (invocation.command === 'test.forbidden') {
			return {
				_tag: 'Failure',
				error: {
					code: 'tenant_mismatch',
					message: 'Authenticated subject is outside the invocation tenant',
					retryable: false,
					outcome: 'known',
					httpStatus: 403
				}
			};
		}
		if (invocation.command === 'sync.connect') {
			// Initial versioned prefixes are computed from current truth under the presented credential.
			lastAdvance = null;
			const request = invocation.input;
			return ok({
				status: 200,
				headers: {},
				value: {
					results: (request.queries ?? []).map((query) => ({
						key: query.queryKey,
						input: query.input,
						planKey: `fixture:${query.input.collection}`,
						version: 1,
						prefixKeys: [{ id: 'note-1', order: ['note-1'] }],
						loadedPrefix: 1,
						prefixBytes: 20,
						authorityFingerprint: 'fixture-policy',
						dependencies: ['fixture-notes'],
						routing: [],
						rows: [{ id: 'note-1' }]
					})),
					outcomes: []
				}
			});
		}
		if (invocation.command === 'sync.extendPrefix') {
			const { request, state } = invocation.input;
			return ok({
				status: 200,
				headers: {},
				value: {
					queryKey: request.queryKey,
					version: request.version,
					fromPrefix: request.loadedPrefix,
					toPrefix: request.requestedPrefix,
					rows: [{ id: 'note-2' }],
					retainedBytes: 40,
					prefixKeys: [...state.prefixKeys, { id: 'note-2', order: ['note-2'] }]
				}
			});
		}
		if (invocation.command === 'sync.advance') {
			// One version-fenced prefix delta per affected plan; writer ledger ids settle alongside it.
			// The real runtime admits this command only from a host-signed system principal. The
			// fixture mirrors that gate so an unsigned advance cannot hide behind a fake guest.
			lastAdvance = {
				signature: invocation.headers['x-colony-system-signature']?.[0] ?? null,
				timestamp: invocation.headers['x-colony-system-timestamp']?.[0] ?? null,
				input: invocation.input
			};
			if (lastAdvance.signature === null || lastAdvance.timestamp === null) {
				return {
					_tag: 'Failure',
					error: {
						code: 'unauthorized',
						message: 'sync.advance requires a host system signature',
						retryable: false,
						outcome: 'known',
						httpStatus: 401
					}
				};
			}
			const request = invocation.input;
			return ok({
				status: 200,
				headers: {},
				value: {
					updates: (request.subscriptions ?? []).map((subscription) => ({
						subId: subscription.subId,
						fromVersion: subscription.version,
						toVersion: subscription.version + 1,
						prefixKeys: [
							{ id: 'note-1', order: ['note-1'] },
							{ id: 'note-2', order: ['note-2'] }
						],
						prefixBytes: 40 + notePayload.length,
						deltas: subscription.viewerPrefixes.map((loadedPrefix) => ({
							loadedPrefix,
							delta: {
								removeIds: [],
								put: [
									{
										id: 'note-1',
										index: 0,
										row: {
											id: 'note-1',
											revised: true,
											...(notePayload ? { payload: notePayload } : {})
										}
									}
								]
							}
						})),
						authorityFingerprint: subscription.authorityFingerprint,
						dependencies: ['fixture-notes']
					})),
					resets: [],
					outcomes: (request.pending ?? []).map((id) => ({
						id,
						status: { resolution: 'accepted', schemaFingerprint: 'fixture-schema' }
					}))
				}
			});
		}
		if (invocation.command === 'test.lastAdvance') {
			return ok({ status: 200, headers: {}, value: lastAdvance });
		}
		if (invocation.command === 'test.mutate') {
			const idempotencyKey = invocation.input?.idempotencyKey;
			notePayload = 'x'.repeat(invocation.input?.payloadBytes ?? 0);
			return ok({
				status: 200,
				headers: {},
				value: { mutationId: idempotencyKey ?? null },
				changes: [
					{
						collection: 'fixture-notes',
						id: 'note-2',
						operation: 'insert',
						after: { id: 'note-2' },
						mutationId: idempotencyKey
					}
				]
			});
		}
		return ok({
			status: 200,
			headers: {},
			value: {
				command: invocation.command,
				input: invocation.input,
				authorization: invocation.headers.authorization?.[0] ?? null
			}
		});
	}
	if (invocation._tag === 'Request') {
		if (invocation.url === '/api/cancel') {
			await new Promise((_, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		}
		return ok({
			status: 200,
			headers: { 'content-type': ['application/json; charset=utf-8'] },
			value: {
				method: invocation.method,
				url: invocation.url,
				authorization: invocation.headers.authorization?.[0] ?? null,
				body: invocation.body ? new TextDecoder().decode(invocation.body) : null,
				tenantId: invocation.scope.tenantId
			}
		});
	}

	if (invocation._tag === 'Realtime') {
		if (invocation.event._tag === 'Open') {
			return ok({
				status: 101,
				headers: {},
				realtime: {
					frames: [{ cursor: 'open-1', kind: 'text', bytes: new TextEncoder().encode('open') }],
					nextCursor: 'open-1'
				}
			});
		}
		if (invocation.event._tag === 'Pull') {
			return ok({
				status: 200,
				headers: {},
				realtime: {
					frames: [{ cursor: 'pull-2', kind: 'text', bytes: new TextEncoder().encode('pulled') }]
				}
			});
		}
		if (invocation.event._tag === 'Input') {
			return ok({
				status: 200,
				headers: {},
				realtime: {
					frames: [
						{
							cursor: `input-${invocation.event.frame.sequence}`,
							kind: invocation.event.frame.kind,
							bytes: invocation.event.frame.bytes
						}
					]
				}
			});
		}
		if (invocation.event._tag === 'Cancel') {
			return ok({
				status: 200,
				headers: {},
				realtime: {
					frames: [
						{ cursor: 'cancel-3', kind: 'text', bytes: new TextEncoder().encode('cancelled') }
					]
				}
			});
		}
	}

	return ok({ status: 204, headers: {} });
};

// The fixture declares no schedules and nothing is ever queued, so there is no instant to arm the
// host's timer to — which is the ordinary state of an idle workspace, and the one that must cost
// nothing rather than a heartbeat.
export const activate = async () => ({
	_tag: 'Activated',
	registrations: [],
	nextDueAtEpochMs: null
});
