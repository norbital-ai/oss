// The engine manifest (W2.F2b): one decoder for `bolt check` and every artifact read refuses what is not a manifest with
// `ManifestInvalid`; the accessors derive, once per manifest, what interiors recomputed and cast.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { discover } from '../src/compiler/discover.ts';
import { load, type Manifest } from '../src/compiler/load.ts';
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
	exposures: {},
	integrations: {},
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
			{
				...base,
				models: { orders: { description: 'Orders', label: 'number', fields: {}, was: 123 } }
			},
			{ ...base, workspace: { locale: 'en' } },
			{ ...base, teams: { sales: 'p' } },
			{ ...base, policies: { p: { description: '', grants: { orders: { read: 'all' } } } } },
			{ ...base, policies: { p: { description: '', grants: { orders: { moves: ['a->b'] } } } } },
			{ ...base, policies: { p: { description: '', grants: { orders: { reed: true } } } } },
			{
				...base,
				policies: { p: { description: '', grants: { orders: { actions: ['submit'] } } } }
			},
			// approval comes from a write arm's check verdict: no approval key beside the grants, none on an arm
			{
				...base,
				policies: {
					p: { description: '', grants: { orders: { approval: { update: { steps: [['f']] } } } } }
				}
			},
			{ ...base, policies: { p: { description: '', grants: { orders: { update: { approval: true } } } } } },
			// write `where`/`previous` and `via` are gone: a check judges the batch, a layer is its root's
			{ ...base, policies: { p: { description: '', grants: { orders: { update: { where: 'read' } } } } } },
			{ ...base, policies: { p: { description: '', grants: { lines: { via: 'order' } } } } },
			{ ...base, pipelines: {} },
			null
		]) {
			const e = refusal(bad);
			expect(e).toBeInstanceOf(ManifestInvalid);
			expect(e?.issues.length).toBeGreaterThan(0);
		}
	});

	it('keeps a standalone automation outside model exposure', () => {
		const m = Result.getOrThrow(
			decodeManifest({
				...base,
				models: {
					orders: { description: 'Orders', label: 'number', fields: { number: { kind: 'text' } } }
				},
				exposures: { orders: { read: { orders: { fields: 'all' } } } },
				automations: {
					orders_submit: {
						description: 'Submit an order through its native update.',
						runAs: 'trigger',
						input: { target: { kind: 'id', of: 'orders' } }
					}
				}
			})
		);
		expect(m.automations.orders_submit).toEqual({
			description: 'Submit an order through its native update.',
			runAs: 'trigger',
			input: { target: { kind: 'id', of: 'orders' } }
		});
		expect(m.exposures.orders).toEqual({ read: { orders: { fields: 'all' } } });
	});

	it('decodes each grant once: read layers, the columns and check marker of a write arm and moves arrive typed', () => {
		const m = Result.getOrThrow(
			decodeManifest({
				...base,
				policies: {
					rep: {
						description: '',
						grants: {
							orders: {
								read: {
									orders: { where: { region: { eq: 'north' } }, fields: ['region'] },
									'orders.lines': { where: { qty: { gt: 0 } } }
								},
								create: { columns: { orders: ['region'], 'orders.lines': ['qty'] } },
								update: { check: true },
								delete: { check: true },
								moves: { status: ['draft->sent'] }
							},
							lines: { read: true }
						}
					}
				}
			})
		);
		const grant = m.policies.rep?.grants.orders;
		expect(grant?.read).toEqual({
			orders: { where: { region: { eq: 'north' } }, fields: ['region'] },
			'orders.lines': { where: { qty: { gt: 0 } } }
		});
		expect(grant?.create).toEqual({ columns: { orders: ['region'], 'orders.lines': ['qty'] } });
		expect(grant?.update).toEqual({ check: true });
		expect(grant?.delete).toEqual({ check: true });
		expect(m.policies.rep?.grants.lines?.read).toBe(true);
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

describe('projectManifest', () => {
	const loaded = (over: Partial<Manifest>): Manifest => ({
		workspace: { '': { tz: 'UTC', locale: 'en' } },
		secrets: {},
		model: {},
		representation: {},
		custom_field: {},
		renderer: {},
		integration_definition: {},
		integration_setup: {},
		policy: {},
		team: {},
		agent: {},
		agent_external: {},
		envoy: {},
		skill: {},
		mcp: {},
		automation: {},
		app: {},
		kiosk: {},
		kiosk_page: {},
		kiosk_page_server: {},
		session: {},
		page: {},
		page_server: {},
		messages: {},
		locale: {},
		group: {},
		...over
	});
	it('splits each model into its storage, its refs and, with `read`, its exposure; a model without `read` is not exposed', () => {
		const m = Result.getOrThrow(
			decodeManifest(
				projectManifest(
					loaded({
						model: {
							// as the check serializer hands it over (a body is `true`), or as loaded (a function)
							orders: {
								name: 'orders',
								spec: {
									description: 'Orders',
									was: 'prior_orders',
									label: 'number',
									fields: {
										number: { kind: 'text' },
										customer: { kind: 'ref', to: 'customers', inverse: 'orders' }
									},
									read: 'all',
									create: { columns: { orders: ['number', 'customer'] }, transform: true },
									update: { columns: { orders: ['number'] }, transform: () => [] },
									delete: {}
								},
								bodies: {}
							},
							customers: {
								description: 'Customers',
								label: 'name',
								fields: { name: { kind: 'text' } }
							}
						}
					})
				)
			)
		);
		expect(m.models.orders?.fields).toEqual({ number: { kind: 'text' } });
		expect(m.models.orders?.was).toBe('prior_orders');
		expect(m.relationships).toEqual({ 'orders.customer': { to: 'customers', inverse: 'orders' } });
		expect(m.exposures.orders).toEqual({
			read: { orders: { fields: 'all' } },
			create: { columns: { orders: ['number', 'customer'] }, transform: true },
			update: { columns: { orders: ['number'] }, transform: true },
			delete: {}
		});
		expect(m.exposures).not.toHaveProperty('customers');
		expect(m.models).toHaveProperty('customers');
	});

	it("marks bodies the engine must know of and keeps no function: a write arm's check, a custom field's validate, an integration's test", () => {
		const m = Result.getOrThrow(
			decodeManifest(
				projectManifest(
					loaded({
						policy: {
							rep: {
								description: '',
								grants: {
									orders: {
										update: { columns: { orders: ['number'] }, check: function* () {} },
										delete: { check: function* () {} },
										read: true
									}
								}
							}
						},
						custom_field: {
							sku: {
								name: 'sku',
								spec: {
									description: 'A SKU.',
									shape: { kind: 'text' },
									validate: () => undefined
								},
								check: () => undefined
							}
						},
						integration_definition: {
							crm: {
								name: 'crm',
								spec: { description: 'CRM', driver: 'http', test: function* () {} },
								bodies: {}
							}
						}
					})
				)
			)
		);
		expect(m.policies.rep?.grants.orders?.update).toEqual({
			columns: { orders: ['number'] },
			check: true
		});
		expect(m.policies.rep?.grants.orders?.delete).toEqual({ check: true });
		expect(m.customFields.sku).toEqual({
			description: 'A SKU.',
			shape: { kind: 'text' },
			check: true
		});
		expect(m.integrations.crm).toEqual({ description: 'CRM', driver: 'http', test: true });
	});
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
