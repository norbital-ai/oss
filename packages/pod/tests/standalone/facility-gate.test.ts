import { describe, expect, it } from 'vitest';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { assertStandaloneFacilities } from '../../src/lib/bin/invocation/standalone.js';

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
});
