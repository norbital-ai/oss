import { describe, expect, it } from 'vitest';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { assertStandaloneFacilities } from '../../src/lib/bin/invocation/standalone.js';
import { satisfiedFacilities } from '../../src/lib/host/types.js';
import { intervalQueue } from '../../src/lib/host/interval-queue.js';
import { postgresDb } from '../../src/lib/host/db.js';
import { devIdentity } from '../../src/lib/host/identity.js';
import type { SelfHostedPodHostConfig } from '../../src/lib/host/types.js';

function hostConfig(overrides: Partial<SelfHostedPodHostConfig> = {}): SelfHostedPodHostConfig {
	return {
		mode: 'self-hosted',
		db: postgresDb({ url: 'postgres://localhost:5432/pod' }),
		identity: devIdentity({ userId: 'u', organizationId: 'o', organizationName: 'Org' }),
		...overrides
	};
}

function manifest(overrides: Partial<NorbitalManifest> = {}): NorbitalManifest {
	return {
		version: 1,
		collections: {},
		relationships: {},
		automations: {},
		...overrides
	};
}

describe('standalone facility gate', () => {
	it('starts a database-only workspace', () => {
		expect(() => assertStandaloneFacilities(manifest(), new Set(['db']))).not.toThrow();
	});

	it('refuses a workspace instead of starting with an inert AI or queue capability', () => {
		const agentWorkspace = manifest({
			automations: {
				triage: {
					trigger: { schedule: '0 6 * * *' },
					spec: { kind: 'agent', task: 'Triage records' }
				}
			}
		});

		expect(() => assertStandaloneFacilities(agentWorkspace, new Set(['db']))).toThrow(
			/unavailable runtime facilities: queue, ai/
		);
		expect(() =>
			assertStandaloneFacilities(agentWorkspace, new Set(['db', 'queue', 'ai']))
		).not.toThrow();
	});

	it('requires every facility structurally implied by files, maps, and integrations', () => {
		const full = manifest({
			collections: {
				assets: {
					collection_name: 'assets',
					description: null,
					record_label: null,
					icon: null,
					fields: [
						{ name: 'file', kind: 'file', nullable: true },
						{ name: 'location', kind: 'geolocation', nullable: true }
					],
					extensions: { indexes: [] },
					hooks: {},
					pipelines: {},
					system: null
				}
			},
			integrations: { crm: { name: 'crm', definition: {} } }
		});
		expect(() => assertStandaloneFacilities(full, new Set(['db']))).toThrow(
			/fileStorage, maps, integrationDelivery, queue/
		);
	});

	it('satisfies queue from a supplied binding, not from a declared intent', () => {
		// The previous contract was a boolean, so a host could claim `queue` while providing nothing
		// to run the jobs. Deriving it from the binding makes the claim impossible to fake.
		expect(satisfiedFacilities(hostConfig()).has('queue')).toBe(false);
		expect(satisfiedFacilities(hostConfig({ queue: intervalQueue() })).has('queue')).toBe(true);
	});

	it('refuses a workspace whose automations have no queue to run them', () => {
		const scheduled = manifest({
			automations: { nightly: { trigger: { schedule: '0 6 * * *' } } }
		});
		expect(() => assertStandaloneFacilities(scheduled, satisfiedFacilities(hostConfig()))).toThrow(
			/queue/
		);
		expect(() =>
			assertStandaloneFacilities(
				scheduled,
				satisfiedFacilities(hostConfig({ queue: intervalQueue() }))
			)
		).not.toThrow();
	});
});
