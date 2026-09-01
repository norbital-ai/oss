export const protocolVersion = 8;

export const manifest = {
	protocolVersion: 8,
	artifactId: 'bolt-server-schedule-fixture',
	artifactVersion: 'fixture-1',
	schemaFingerprint: 'fixture-schema',
	schemaPlan: { fingerprint: 'fixture-schema', steps: [] },
	requiredFacilities: [],
	browserAssets: [],
	serverAssets: [],
	integrations: []
};

/**
 * A guest with one occurrence to hand out, which is the whole of what the tick loop needs to prove.
 *
 * It answers the three commands the host command protocol is made of and records what arrived, so a
 * test can assert on the conversation rather than on the fact that a dispatch happened. Discovery
 * hands out its single occurrence once and reports nothing due afterwards, so the host's timer
 * disarms and the run is exactly one tick.
 */
const log = [];
let handedOut = false;

const occurrence = {
	taskId: 'schedule:nightly@1',
	scheduleKey: 'nightly',
	scheduledForEpochMs: 1,
	command: 'automations.nightly',
	input: { proof: true },
	attempt: 2
};

const ok = (value) => ({ _tag: 'Success', response: { status: 200, headers: {}, value } });

export const dispatch = async (invocation) => {
	if (invocation._tag === 'Command' && invocation.command === 'host.schedules.discover') {
		log.push({
			kind: 'discover',
			input: invocation.input,
			signature: invocation.headers['x-colony-system-signature']?.[0] ?? null,
			timestamp: invocation.headers['x-colony-system-timestamp']?.[0] ?? null
		});
		if (handedOut) return ok({ occurrences: [], rejections: [], nextDueAtEpochMs: null });
		handedOut = true;
		return ok({ occurrences: [occurrence], rejections: [], nextDueAtEpochMs: null });
	}
	if (invocation._tag === 'Command' && invocation.command === 'host.schedules.settle') {
		log.push({
			kind: 'settle',
			taskId: invocation.input.occurrence.taskId,
			outcome: invocation.input.outcome,
			signature: invocation.headers['x-colony-system-signature']?.[0] ?? null
		});
		return ok({ settled: true, nextDueAtEpochMs: null });
	}
	if (invocation._tag === 'Task') {
		log.push({
			kind: 'task',
			command: invocation.command,
			input: invocation.input,
			attempt: invocation.attempt
		});
		return ok({ ran: invocation.command });
	}
	if (invocation._tag === 'Request') {
		return {
			_tag: 'Success',
			response: {
				status: 200,
				headers: { 'content-type': ['application/json; charset=utf-8'] },
				value: { url: invocation.url, log }
			}
		};
	}
	return ok(null);
};

// Something is due immediately, so the host arms its timer on the activation answer alone and the
// first tick is the one this fixture is here to observe.
export const activate = async () => ({
	_tag: 'Activated',
	registrations: [],
	nextDueAtEpochMs: Date.now()
});
