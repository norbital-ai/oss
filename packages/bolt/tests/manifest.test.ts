// The engine manifest (W2.F2b): one decoder for `bolt check` and every artifact read refuses what is not a manifest with
// `ManifestInvalid`; the accessors derive, once per manifest, what interiors recomputed and cast.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { discover } from '../src/compiler/discover.ts';
import { load } from '../src/compiler/load.ts';
import { ManifestInvalid } from '../src/engine/errors.ts';
import {
	challengedApps,
	declaredSecrets,
	decodeManifest,
	layered,
	projectManifest,
	publicEnvoys,
	relations,
	stateField,
	teams,
	type EngineManifest
} from '../src/engine/manifest.ts';

const base: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	collections: {},
	integrations: {},
	pipelines: {},
	policies: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const refusal = (u: unknown) =>
	Result.match(decodeManifest(u), { onFailure: (e) => e, onSuccess: () => undefined });

describe('decodeManifest', () => {
	it('ManifestInvalid: an unknown part, a part that is no object, a workspace without its zone', () => {
		expect(Result.isSuccess(decodeManifest(base))).toBe(true);
		for (const bad of [
			{ ...base, extra: {} },
			{ ...base, models: { orders: 'orders' } },
			{ ...base, workspace: { locale: 'en' } },
			{ ...base, teams: { sales: 'p' } },
			null
		]) {
			const e = refusal(bad);
			expect(e).toBeInstanceOf(ManifestInvalid);
			expect(e?.issues.length).toBeGreaterThan(0);
		}
	});

	it.live(
		'decodes the loaded fixture as projected: wrappers give their literal, connections are their own part',
		() =>
			Effect.gen(function* () {
				const root = fileURLToPath(new URL('./fixtures/good', import.meta.url));
				const { files } = yield* discover(root);
				const { manifest } = yield* load(root, files);
				const m = Result.getOrThrow(decodeManifest(projectManifest(manifest)));
				expect(m.workspace).not.toHaveProperty('connections');
				expect(m.connections.support).toEqual({ integration: 'mail', envoy: 'desk' });
				expect(m.teams).toEqual({ Sales: ['sales_rep'] });
				expect(m.apps.sales?.title).toBe('Sales');
				expect(m.kiosks?.clock?.policies).toEqual(['kiosk_reader']);
			}).pipe(Effect.provide(NodeServices.layer))
	);
});

describe('manifest accessors', () => {
	const m: EngineManifest = {
		...base,
		workspace: {
			tz: 'UTC',
			locale: 'en',
			secrets: {
				API_URL: { label: 'API' },
				API_KEY: { label: 'Key' }
			}
		},
		models: {
			orders: {
				description: 'Orders',
				label: 'number',
				fields: {
					number: { kind: 'text' },
					status: { kind: 'state', initial: 'draft', states: { draft: { to: ['done'] }, done: {} } }
				}
			},
			lines: { description: 'Lines', label: 'sku', fields: { sku: { kind: 'text' } } }
		},
		relationships: { 'lines.order': { to: 'orders', inverse: 'lines' } },
		teams: { sales: ['rep'], leads: { name: 'Leads', parent: 'sales', policies: ['lead'] } },
		envoys: {
			desk: {
				name: 'Desk',
				audience: 'public',
				policies: ['rep'],
				delegation: 'disabled',
				task: 'Answer.'
			},
			staff: {
				name: 'Staff',
				audience: 'private',
				policies: ['rep'],
				delegation: 'disabled',
				task: 'Answer.'
			}
		},
		apps: {
			shop: {
				title: 'Shop',
				description: 'Shop',
				icon: 'cart',
				audience: { public: ['rep'], challenge: 'turnstile' },
				pages: {}
			},
			crm: {
				title: 'CRM',
				description: 'CRM',
				icon: 'users',
				audience: { public: ['rep'] },
				pages: {}
			}
		}
	};

	it('derive the public envoys, the secrets, the challenged apps and the normalised teams', () => {
		expect(publicEnvoys(m)).toEqual(['desk']);
		expect(declaredSecrets(m)).toEqual(['API_URL', 'API_KEY']);
		expect(challengedApps(m)).toEqual(['shop']);
		expect(teams(m)).toEqual({
			sales: { name: 'sales', parent: null, policies: ['rep'] },
			leads: { name: 'Leads', parent: 'sales', policies: ['lead'] }
		});
		expect(publicEnvoys(m)).toBe(publicEnvoys(m));
	});

	it('stateField, the relation index and the built-in layer', () => {
		expect(stateField(m, 'orders')).toEqual({
			name: 'status',
			spec: { kind: 'state', initial: 'draft', states: { draft: { to: ['done'] }, done: {} } }
		});
		expect(stateField(m, 'lines')).toBeUndefined();
		const index = relations(m);
		expect(index.from.get('lines')?.map((r) => [r.fk, r.targets])).toEqual([['order', ['orders']]]);
		expect(index.inverse.get('orders.lines')?.key).toBe('lines.order');
		expect(Object.keys(layered(m).models)).toEqual(
			expect.arrayContaining(['sys_user', 'sys_run', 'orders', 'lines'])
		);
		expect(layered(m)).toBe(layered(m));
		expect(
			relations(layered(m))
				.from.get('sys_session')
				?.map((r) => r.fk)
		).toEqual(expect.arrayContaining(['user', 'impersonated_by']));
	});
});
