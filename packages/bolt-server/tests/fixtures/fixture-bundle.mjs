export const protocolVersion = 3;

export const manifest = {
	protocolVersion: 3,
	artifactId: 'bolt-server-fixture',
	artifactVersion: 'fixture-1',
	schemaFingerprint: 'fixture-schema',
	schemaPlan: { fingerprint: 'fixture-schema', steps: [] },
	requiredFacilities: [],
	staticAssets: [
		{
			path: 'index.html',
			contentType: 'text/plain; charset=utf-8',
			sha256: '4290f01183a1ad0c3b7ba37eb33d0a307d414b04c98acf67307d881192bb118d',
			bytes: new TextEncoder().encode('bolt fixture')
		}
	],
	// Present and empty, not absent: the manifest schema requires the field so a host can tell a
	// workspace that declares no integrations from an artifact built before manifests carried them.
	integrations: []
};

const ok = (response) => ({ _tag: 'Success', response });

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
