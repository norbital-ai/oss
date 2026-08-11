import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import {
	assertStandaloneFacilities,
	manifestChannelTransports
} from '../../src/serve/standalone.js';
import { loadHostConfig } from '../../src/host/config.js';
import { satisfiedFacilities, type RuntimeFacilityName } from '../../src/host/types.js';
import { intervalQueue } from '../../src/host/interval-queue.js';
import { postgresDb } from '../../src/host/db.js';
import { devIdentity } from '../../src/host/identity.js';
import type { SelfHostedPodHostConfig } from '../../src/host/types.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

/** A Core-targeted workspace root, which is what `pod dev` emulates. */
async function coreWorkspace(): Promise<string> {
	const root = await mkdtemp(path.join(REPO_ROOT, '.test-workspaces/facility-'));
	temporaryRoots.push(root);
	await symlink(
		path.join(REPO_ROOT, 'template_workspaces/construction/node_modules'),
		path.join(root, 'node_modules')
	);
	await writeFile(
		path.join(root, 'pod.host.ts'),
		`import { definePodHost } from '@norbital-ai/pod/host';\nexport default definePodHost({ mode: 'core' });\n`
	);
	return root;
}

async function developmentFacilities(): Promise<ReadonlySet<RuntimeFacilityName>> {
	const { config } = await loadHostConfig({
		root: await coreWorkspace(),
		development: true,
		databaseUrl: 'postgres://localhost:5432/pod',
		publicUrl: 'http://localhost:5173',
		orgId: 'o',
		orgName: 'Org',
		adminId: 'a'
	});
	return satisfiedFacilities(config);
}

function hostConfig(overrides: Partial<SelfHostedPodHostConfig> = {}): SelfHostedPodHostConfig {
	return {
		mode: 'self-hosted',
		db: postgresDb({ url: 'postgres://localhost:5432/pod' }),
		identity: devIdentity({ userId: 'u', organizationId: 'o', organizationName: 'Org' }),
		publicUrl: 'http://localhost:5173',
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
					description: 'Sorts the overnight records into the queues that handle them.',
					trigger: { schedule: '0 6 * * *' },
					spec: {
						kind: 'agent',
						description: 'Sorts the overnight records into the queues that handle them.',
						task: 'Triage records'
					}
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
		// `maps` is deliberately absent: a geolocation value is self-contained, so only edit-time
		// autocomplete and static-map rendering need a provider, and those validate when called.
		expect(() => assertStandaloneFacilities(full, new Set(['db']))).toThrow(
			/fileStorage, integrationDelivery, queue/
		);
		expect(() =>
			assertStandaloneFacilities(
				full,
				new Set(['db', 'fileStorage', 'integrationDelivery', 'queue'])
			)
		).not.toThrow();
	});

	it('satisfies queue from a supplied binding, not from a declared intent', () => {
		// The previous contract was a boolean, so a host could claim `queue` while providing nothing
		// to run the jobs. Deriving it from the binding makes the claim impossible to fake.
		expect(satisfiedFacilities(hostConfig()).has('queue')).toBe(false);
		expect(satisfiedFacilities(hostConfig({ queue: intervalQueue() })).has('queue')).toBe(true);
	});

	it('refuses a workspace whose automations have no queue to run them', () => {
		const scheduled = manifest({
			automations: {
				nightly: {
					description: 'Runs the nightly bookkeeping pass.',
					trigger: { schedule: '0 6 * * *' }
				}
			}
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

describe('pod dev facility gate', () => {
	it('supplies only what it actually implements', async () => {
		// `pod dev` emulates Core but holds none of Core's credentials. Enumerating the set here means
		// a facility silently appearing (or disappearing) from the development host is a test failure.
		// `messaging` and `integrationDelivery` are in the set but hold no credentials either: both write
		// to the console, which is what lets a workspace with channels or an integration boot under
		// `pod dev` at all.
		expect([...(await developmentFacilities())].sort()).toEqual([
			'db',
			'fileStorage',
			'integrationDelivery',
			'messaging',
			'queue'
		]);
	});

	it('refuses to start a workspace whose facilities it cannot provide', async () => {
		const available = await developmentFacilities();
		const agentWorkspace = manifest({
			automations: {
				triage: {
					description: 'Sorts the overnight records into the queues that handle them.',
					trigger: { schedule: '0 6 * * *' },
					spec: {
						kind: 'agent',
						description: 'Sorts the overnight records into the queues that handle them.',
						task: 'Triage'
					}
				}
			}
		});
		// Starting anyway would fail at the first inference call, far from the cause.
		expect(() => assertStandaloneFacilities(agentWorkspace, available)).toThrow(/ai/);
	});

	/**
	 * `pod dev` holds no sockets, so it stands in for whatever transports the workspace declares and
	 * logs what would have been sent. That only works if the declared set is readable from the
	 * manifest — the host never loads the workspace bundle.
	 */
	it('reads the declared channel transports out of the manifest for the development host', async () => {
		expect(
			manifestChannelTransports(
				manifest({
					channels: {
						sales_desk: {
							key: 'sales_desk',
							transport: 'telegram',
							policy: 'sales_rep',
							description: 'Prospects reaching the sales desk over Telegram.'
						},
						support: {
							key: 'support',
							transport: 'whatsapp',
							policy: 'sales_rep',
							description: 'Existing customers asking for help over WhatsApp.'
						},
						escalations: {
							key: 'escalations',
							transport: 'telegram',
							policy: 'sales_rep',
							description: 'Deals the sales desk hands upward for a decision.'
						}
					}
				})
			)
		).toEqual(['telegram', 'whatsapp']);
		expect(manifestChannelTransports(manifest())).toEqual([]);

		const { config } = await loadHostConfig({
			root: await coreWorkspace(),
			development: true,
			databaseUrl: 'postgres://localhost:5432/pod',
			publicUrl: 'http://localhost:5173',
			orgId: 'o',
			orgName: 'Org',
			adminId: 'a',
			channelTransports: ['telegram']
		});
		expect(await config.messaging?.listTransports()).toEqual(['telegram']);
	});

	/**
	 * A declared integration must not be the thing that makes a workspace unrunnable locally. The
	 * shipped `crm` template declares one, and `pod dev` is the only way a Core target runs at all, so
	 * the development host stands in for delivery and logs — the same bargain it makes for a channel
	 * transport it cannot carry.
	 */
	it('starts a workspace that declares an integration, with no delivery credentials', async () => {
		const available = await developmentFacilities();
		const integrating = manifest({
			integrations: { external_system: { name: 'external_system', definition: {} } }
		});
		expect(() => assertStandaloneFacilities(integrating, available)).not.toThrow();
	});

	it('starts a workspace that only stores geolocation, with no maps provider', async () => {
		const available = await developmentFacilities();
		expect(available.has('maps')).toBe(false);
		const geolocationWorkspace = manifest({
			collections: {
				sites: {
					collection_name: 'sites',
					description: null,
					record_label: null,
					icon: null,
					fields: [{ name: 'location', kind: 'geolocation', nullable: true }],
					extensions: { indexes: [] },
					hooks: {},
					pipelines: {},
					system: null
				}
			}
		});
		// The stored value carries its own geometry and formatted address, so reading and rendering it
		// needs no provider. Requiring one blocked two templates from `pod dev` for a dependency they
		// never use.
		expect(() => assertStandaloneFacilities(geolocationWorkspace, available)).not.toThrow();
	});
});
