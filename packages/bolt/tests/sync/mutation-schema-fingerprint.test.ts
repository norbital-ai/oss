import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { buildManifest } from '../../src/manifest/manifest.js';
import * as Sync from '../../src/runtime/sync/sync.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('compiler-owned mutation schema fingerprint', () => {
	it('is the one fingerprint shared by sync partitioning and M4 reconciliation', async () => {
		const compilerFingerprint = 'sha256:compiler-owned-mutation-schema';
		const definition = {
			...testWorkspace(),
			mutationCompatibility: {
				offlineHorizonMillis: 14 * 24 * 60 * 60 * 1_000,
				currentSchemaFingerprint: compilerFingerprint,
				adapters: []
			}
		};
		expect(buildManifest(definition, { artifactId: 'test:mutation-schema' }).schemaFingerprint).toBe(
			compilerFingerprint
		);
		harness = await makeBoltTestRuntime(definition);
		const facts = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return (yield* Sync.Service).schema();
			})
		);
		expect(facts.fingerprint).toBe(compilerFingerprint);
	});
});
