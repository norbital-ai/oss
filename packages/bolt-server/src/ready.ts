import { Effect, Schema } from 'effect';
import { HealthSnapshot } from './health.js';

/** `GET /readyz` must be 200 with `ready === true` after `startApplication` listens. */
export const waitUntilReady = async (baseUrl: string): Promise<HealthSnapshot> => {
	const ready = await fetch(`${baseUrl.replace(/\/$/, '')}/readyz`);
	if (ready.status !== 200) {
		throw new Error(`GET /readyz returned ${ready.status}`);
	}
	const snapshot = await Effect.runPromise(
		Schema.decodeUnknownEffect(HealthSnapshot)(await ready.json())
	);
	if (snapshot.ready !== true) {
		throw new Error('GET /readyz was not ready');
	}
	return snapshot;
};
