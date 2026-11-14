// The engine manifest (W2.F2b): one decoder for `bolt check` and every artifact read refuses what is not a manifest with
// `ManifestInvalid`; the accessors derive, once per manifest, what interiors recomputed and cast.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { discover } from '../../bolt-cli/src/compiler/discover.ts';
import { load, type Manifest } from '../../bolt-cli/src/compiler/load.ts';
import { ManifestInvalid } from '../src/engine/errors.ts';
import {
	declared_secrets,
	decode_manifest,
	decode_projected_manifest,
	layered,
	project_manifest,
	relations,
	stateField,
	teams,
	type EngineManifest
} from '../src/engine/manifest.ts';
import { install } from '../src/decl/runtime/guest.ts';

// the fixtures' generator bodies attach through the guest edge, as `bolt check` installs it
install();

const base: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},

	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};
const refusal = (u: unknown) =>
	Result.match(decode_manifest(u), { onFailure: (e) => e, onSuccess: () => undefined });
const loaded = (over: Partial<Manifest>): Manifest => ({
	workspace: { '': { tz: 'UTC', locale: 'en' } },
	secrets: {}, model: {}, representation: {}, sync: {}, custom_field: {}, renderer: {},
	integration_definition: {}, integration_setup: {}, policy: {}, team: {},
	agent: {}, agent_external: {}, skill: {}, mcp: {}, automation: {}, app: {},
	session: {}, page: {}, messages: {}, locale: {}, group: {},
	...over
});

describe('decode_manifest', () => {
	it('ManifestInvalid: an unknown part, a part that is no object, a workspace without its zone', () => {
		expect(Result.isSuccess(decode_manifest(base))).toBe(true);
		for (const bad of [
			{ ...base, extra: {} },
			{ ...base, models: { orders: 'orders' } },
			{
				...base,
				models: {
					orders: { description: 'Orders', record_label: 'record.number', fields: {}, was: 123 }
				}
			},
			{ ...base, workspace: { locale: 'en' } },
			{ ...base, teams: { sales: 'p' } },
			{ ...base, teams: { sales: ['rep'] } },
			{ ...base, connections: {} },
			{ ...base, messages: { 'models.orders.fields.number': 123 } },
			{ ...base, policies: { p: { description: '', grants: { orders: { read: 'all' } } } } },
			{ ...base, policies: { p: { description: '', grants: { orders: { moves: 'all' } } } } },
			{
				...base,
				policies: { p: { description: '', grants: { orders: { update: { moves: ['a->b'] } } } } }
			},
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
			{
				...base,
				policies: { p: { description: '', grants: { orders: { update: { approval: true } } } } }
			},
			// write `where`/`previous` and `via` are gone: a check judges the batch, a layer is its root's
			{
				...base,
				policies: { p: { description: '', grants: { orders: { update: { where: 'read' } } } } }
			},
			{ ...base, policies: { p: { description: '', grants: { lines: { via: 'order' } } } } },
			{ ...base, pipelines: {} },
			null
		]) {
			const e = refusal(bad);
			expect(e).toBeInstanceOf(ManifestInvalid);
			expect(e?.issues.length).toBeGreaterThan(0);
		}
	});

	it('resolves the authored catalogue with the client exact-locale then language precedence', () => {
		const messages = { '': {
			'models.entries.fields.title': 'Title',
			'models.entries.help.title': 'The entry title',
			'models.entries.syncs.sheet.schema.fields.title': 'Sheet title'
		} };
		const locale = {
			fr: { 'models.entries.fields.title': 'Titre', 'models.entries.help.title': 'Le titre' },
			'FR-CA': { 'models.entries.fields.title': 'Titre canadien' }
		};
		const resolve = (tag: string) => Result.getOrThrow(decode_projected_manifest(project_manifest(loaded({
			workspace: { '': { tz: 'UTC', locale: tag } }, messages, locale
		})))).messages;
		expect(resolve('fr-CA')).toEqual({
			...messages[''], 'models.entries.fields.title': 'Titre canadien'
		});
		expect(resolve('FR-FR')).toEqual({
			...messages[''], ...locale.fr
		});
		expect(resolve('de-DE')).toEqual(messages['']);
		expect(Result.getOrThrow(decode_projected_manifest(project_manifest(loaded({}))))).not.toHaveProperty('messages');
	});

	it('refuses malformed base and locale catalogues, including an unselected locale', () => {
		for (const over of [
			{ messages: { '': { title: 123 } } },
			{ messages: { '': undefined } },
			{ locale: { en: null } },
			{ locale: { fr: { title: false } } }
		]) expect(() => project_manifest(loaded(over))).toThrow(ManifestInvalid);
	});

	it('keeps a standalone automation outside model exposure', () => {
		const m = Result.getOrThrow(
			decode_manifest({
				...base,
				models: {
					orders: {
						description: 'Orders',
						record_label: 'record.number',
						fields: { number: { kind: 'text' } }
					}
				},
				exposures: { orders: { outputs: { default: { orders: { fields: 'all' } } } } },
				automations: {
					orders_submit: {
						description: 'Submit an order through its native update.',
						policies: ['clerk'],
						input: { target: { kind: 'ref', to: 'orders' } }
					}
				}
			})
		);
		expect(m.automations.orders_submit).toEqual({
			description: 'Submit an order through its native update.',
			policies: ['clerk'],
			input: { target: { kind: 'ref', to: 'orders' } }
		});
		expect(m.exposures.orders).toEqual({ outputs: { default: { orders: { fields: 'all' } } } });
	});

	it('decodes each grant once: read layers, the columns and check marker of a write arm and moves arrive typed', () => {
		const m = Result.getOrThrow(
			decode_manifest({
				...base,
				policies: {
					rep: {
						description: '',
						grants: {
							orders: {
								outputs: {
									default: {
										scopes: {
											orders: { region: { eq: 'north' } },
											'orders.lines': { qty: { gt: 0 } }
										}
									}
								},
								create: { columns: { orders: ['region'], 'orders.lines': ['qty'] } },
								update: { verdict: true, moves: { status: ['draft->sent'] } },
								delete: { verdict: true }
							},
							lines: { outputs: { default: {} } }
						}
					}
				}
			})
		);
		const grant = m.policies.rep?.grants.orders;
		expect(grant?.outputs?.default).toEqual({
			scopes: {
				orders: { region: { eq: 'north' } },
				'orders.lines': { qty: { gt: 0 } }
			}
		});
		expect(grant?.create).toEqual({ columns: { orders: ['region'], 'orders.lines': ['qty'] } });
		expect(grant?.update).toEqual({ verdict: true, moves: { status: ['draft->sent'] } });
		expect(grant?.delete).toEqual({ verdict: true });
		expect(m.policies.rep?.grants.lines?.outputs?.default).toEqual({});
	});

	it.live(
		'decodes the loaded fixture as projected: wrappers give their literal, and accounts stay outside source',
		() =>
			Effect.gen(function* () {
				const root = fileURLToPath(new URL('./fixtures/good', import.meta.url));
				const { files } = yield* discover(root);
				const { manifest } = yield* load(root, files);
				const m = Result.getOrThrow(decode_projected_manifest(project_manifest(manifest)));
				expect(m.workspace).not.toHaveProperty('connections');
				expect(m).not.toHaveProperty('connections');
				expect(m.integrations.mail).toMatchObject({ driver: 'email' });
				expect(m.teams).toEqual({ sales: { name: 'Sales', policies: ['sales_rep'] } });
				expect(m.apps.sales?.title).toBe('Sales');
				expect(m.apps.clock?.policies).toEqual(['kiosk_reader']);
			}).pipe(Effect.provide(NodeServices.layer))
	);
});

describe('project_manifest', () => {
	it('lowers field computations and named indexes through the normal model projection', () => {
		const m = Result.getOrThrow(
			decode_projected_manifest(
				project_manifest(
					loaded({
						model: {
							entries: {
								description: 'Entries',
								record_label: 'record.title',
								fields: {
									title: { kind: 'text' },
									amount: { kind: 'int' },
									doubled: { kind: 'int', computed: 'amount * 2' }
								},
								indexes: { by_title: { on: ['title'] }, find: { text: ['title'] } },
								outputs: { default: { fields: 'all' } }
							}
						}
					})
				)
			)
		);
		expect(m.models.entries).toEqual({
			description: 'Entries',
			record_label: 'record.title',
			fields: { title: { kind: 'text' }, amount: { kind: 'int' } },
			computed: { doubled: { kind: 'int', expr: { times: [{ field: 'amount' }, 2] } } },
			indexes: [{ on: ['title'] }],
			search: { text: ['title'] }
		});
	});
	it('refuses removed label, computed and index authoring forms', () => {
		for (const removed of [
			{ label: 'title' },
			{ computed: {} },
			{ index: ['title'] },
			{ search: { text: ['title'] } },
			{ table: { primary: 'text', indexes: [] } }
		])
			expect(() =>
				project_manifest(
					loaded({
						model: {
							entries: {
								description: 'Entries',
								fields: { title: { kind: 'text' } },
								...removed
							}
						}
					})
				)
			).toThrow();
	});
	it('splits each model into its storage, its refs and the exposure declared by its outputs', () => {
		const m = Result.getOrThrow(
			decode_projected_manifest(
				project_manifest(
					loaded({
						model: {
							// as the check serializer hands it over (a body is `true`), or as loaded (a function)
							orders: {
								name: 'orders',
								spec: {
									description: 'Orders',
									was: 'prior_orders',
									record_label: 'record.number',
									fields: {
										number: { kind: 'text' },
										customer: { kind: 'ref', to: 'customers', inverse: 'orders' }
									},
									constraints: {
										one_number: { unique: ['number'] },
										numbered: { check: { number: { ne: '' } } },
										unassigned: { locked: { customer: { is_null: true } }, except: ['customer'] }
									},
									outputs: { default: { fields: 'all' } },
									create: { fields: ['number', 'customer'], transform: true },
									update: { fields: ['number'], transform: () => [] },
									delete: {}
								},
								bodies: {}
							},
							customers: {
								description: 'Customers',
								record_label: 'record.name',
								fields: { name: { kind: 'text' } }
							}
						}
					})
				)
			)
		);
		expect(m.models.orders?.fields).toEqual({ number: { kind: 'text' } });
		expect(m.models.orders?.was).toBe('prior_orders');
		expect(m.models.orders).toMatchObject({
			unique: [{ fields: ['number'], name: 'one_number' }],
			check: { numbered: { number: { ne: '' } } },
			locks: { unassigned: { where: { customer: { is_null: true } }, except: ['customer'] } }
		});
		expect(m.relationships).toEqual({ 'orders.customer': { to: 'customers', inverse: 'orders' } });
		expect(m.exposures.orders).toEqual({
			outputs: { default: { orders: { fields: 'all' } } },
			create: { columns: { orders: ['number', 'customer'] }, transform: true },
			update: { columns: { orders: ['number'] }, transform: true },
			delete: {}
		});
		expect(m.exposures).not.toHaveProperty('customers');
		expect(m.models).toHaveProperty('customers');
	});

	it("marks a write arm's verdict, a custom field's validate and an integration's test", () => {
		const m = Result.getOrThrow(
			decode_projected_manifest(
				project_manifest(
					loaded({
						policy: {
							rep: {
								description: '',
								grants: {
									orders: {
										update: { fields: ['number'], verdict: function* () {} },
										delete: { verdict: function* () {} },
										outputs: { default: {} }
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
			verdict: true
		});
		expect(m.policies.rep?.grants.orders?.delete).toEqual({ verdict: true });
		expect(m.custom_fields.sku).toEqual({
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
				record_label: 'record.number',
				fields: {
					number: { kind: 'text' },
					status: { kind: 'state', initial: 'draft', states: { draft: { to: ['done'] }, done: {} } }
				}
			},
			lines: { description: 'Lines', record_label: 'record.sku', fields: { sku: { kind: 'text' } } }
		},
		relationships: { 'lines.order': { to: 'orders', inverse: 'lines' } },
		teams: { sales: { policies: ['rep'] }, leads: { name: 'Leads', parent: 'sales', policies: ['lead'] } },
		apps: {
			shop: {
				title: 'Shop',
				description: 'Shop',
				icon: 'cart',
				audience: { public: ['rep'], challenge: true },
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

	it('derive the secrets and normalised teams', () => {
		expect(declared_secrets(m)).toEqual(['API_URL', 'API_KEY']);
		expect(teams(m)).toEqual({
			sales: { name: 'sales', parent: null, policies: ['rep'] },
			leads: { name: 'Leads', parent: 'sales', policies: ['lead'] }
		});
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
