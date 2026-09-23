import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	channel,
	defineChannel,
	defineIntegration,
	defineModel,
	http,
	text
} from '../src/authoring/index.js';
import type { TablesForModels } from '../src/authoring/contracts-schema.js';
import { describeChannel } from '../src/authoring/channels-schema.js';
import { describeIntegration } from '../src/authoring/integrations-schema.js';
import { envoy, workspace } from '../src/authoring/workspace-schema.js';
import { browserWrite } from '../src/compiler/workspace-build.js';

const models = {
	accounts: defineModel({ external_code: text(), name: text(), currency: text() }),
	sent_emails: defineModel({ to_address: text().notNull(), status: text() })
};
/** A workspace schema as `bolt sync` would generate it, for the types under test. */
type S = { readonly tables: TablesForModels<typeof models>; readonly relations: {} };

const Customer = Schema.Struct({
	code: Schema.String,
	name: Schema.String,
	currency: Schema.String,
	updated_at: Schema.String
});
const erp = http.source({
	baseUrl: { env: 'ERP_BASE_URL' },
	authentication: { type: 'bearer', token: { env: 'ERP_TOKEN' } }
});
const readOnly = erp.records({
	list: { path: '/customers', records: 'customers', page: { query: 'after', next: 'next' } },
	identity: 'code',
	record: Customer
});
const writable = erp.records({
	list: { path: '/customers', records: 'customers' },
	create: { method: 'POST', path: '/customers' },
	update: { method: 'PATCH', path: '/customers/:id' },
	delete: { method: 'DELETE', path: '/customers/:id' },
	identity: 'code',
	version: 'updated_at',
	record: Customer
});

describe('channels', () => {
	it('declares a transport and splits into a declaration and its live half', () => {
		const described = describeChannel(
			'pcn_mail',
			defineChannel<'email', S, 'sent_emails'>({
				transport: 'email',
				address: 'pcn',
				policies: ['integration'],
				outbound: {
					notices: {
						from: 'sent_emails',
						on: 'create',
						message: ({ record }) => ({ to: [record.to_address], subject: 'Notice' })
					}
				},
				events: { delivered: () => ({ status: 'delivered' }) }
			})
		);
		expect(described.declaration).toEqual({
			name: 'pcn_mail',
			transport: 'email',
			address: 'pcn',
			policies: ['integration'],
			outbound: [{ name: 'notices', from: 'sent_emails', events: ['create'] }],
			events: ['delivered']
		});
		expect(described.authored.outbound['notices']?.matches('create', {})).toBe(true);
		expect(described.authored.outbound['notices']?.matches('update', {})).toBe(false);
	});

	it('refuses what a transport cannot carry', () => {
		expect(() => describeChannel('x', { transport: 'fax' })).toThrow(/transports are/);
		expect(() => describeChannel('x', { transport: 'whatsapp', address: 'pcn' })).toThrow(/address/);
		expect(() => describeChannel('x', { transport: 'http' })).toThrow(/connection/);
		expect(() =>
			describeChannel('x', { transport: 'email', outbound: { a: { from: 'c', on: 'create', message: () => ({}) } } })
		).toThrow(/policies/);
		expect(() =>
			describeChannel('x', { transport: 'whatsapp', policies: ['p'], outbound: {}, events: { replied: () => ({}) } })
		).toThrow(/only an email channel/);
		expect(() => describeChannel('x', { transport: 'email', policies: ['p'], events: { opened: () => ({}) } })).toThrow(
			/need an outbound rule/
		);
	});

	it('holds one envoy per conversation channel', () => {
		const base = {
			name: 'w',
			version: '1',
			collections: [],
			apps: [],
			policies: [],
			prompt: 'p',
			tools: [],
			skills: [],
			automations: [],
			integrations: [],
			requiredFacilities: []
		} as const;
		const desk = (name: string, on: string) =>
			envoy({ name, channel: on, audience: 'public', policies: ['p'], delegation: 'disabled', task: 't' });
		const channels = [
			describeChannel('wa', { transport: 'whatsapp' }).declaration,
			describeChannel('hook', { transport: 'http', connection: { baseUrl: 'https://x.test' } }).declaration
		];
		expect(() => workspace({ ...base, channels, envoys: [desk('a', 'wa'), desk('b', 'wa')] })).toThrow(/one consumer/);
		expect(() => workspace({ ...base, channels, envoys: [desk('a', 'hook')] })).toThrow(/carries no conversation/);
		expect(() => workspace({ ...base, channels, envoys: [desk('a', 'nowhere')] })).toThrow(/not declared/);
	});
});

describe('integrations', () => {
	it('describes a two-way sync, its mapping read both ways and its schedules', () => {
		const described = describeIntegration(
			'erp',
			defineIntegration<S, { accounts: typeof Customer.Type }>({
				policies: ['erp_integration'],
				syncs: {
					accounts: {
						direction: 'two_way',
						source: writable,
						identity: 'external_code',
						fields: { name: 'name', currency: 'currency' },
						owns: { remote: ['currency'] },
						conflicts: 'remote_wins',
						onUnmatchedLocal: 'push',
						reconcile: { schedule: '0 3 * * *' }
					}
				}
			})
		);
		expect(described.declaration.syncs).toEqual([
			expect.objectContaining({
				name: 'accounts',
				direction: 'two_way',
				source: 'http',
				identity: 'external_code',
				fields: [
					{ column: 'name', remote: 'name', pushed: true },
					{ column: 'currency', remote: 'currency', pushed: true }
				],
				owns: { remote: ['currency'], local: [] },
				conflicts: { default: 'remote_wins', fields: {} },
				deletes: 'delete_wins',
				onUnmatchedLocal: 'push',
				reconcileSchedule: '0 3 * * *',
				webhook: false
			})
		]);
	});

	it('refuses a sync that cannot converge', () => {
		const sync = (value: Record<string, unknown>) => ({ policies: ['p'], syncs: { accounts: value } });
		expect(() =>
			describeIntegration('erp', sync({ direction: 'two_way', source: readOnly, identity: 'c', fields: { name: 'name' }, conflicts: 'latest' }))
		).toThrow(/needs a source with create/);
		expect(() =>
			describeIntegration('erp', sync({ direction: 'two_way', source: writable, identity: 'c', fields: { name: 'name' } }))
		).toThrow(/conflict rule/);
		expect(() =>
			describeIntegration('erp', sync({ direction: 'one_way', source: readOnly, identity: 'c', fields: { name: 'name' }, conflicts: 'latest' }))
		).toThrow(/only to a two-way/);
		expect(() =>
			describeIntegration('erp', sync({ direction: 'one_way', source: readOnly, identity: 'c', fields: { name: 'name' }, reconcile: { schedule: '* * * * * *' } }))
		).toThrow(/floor is one minute/);
		expect(() =>
			describeIntegration('mail', sync({ direction: 'two_way', source: channel('pcn_mail').messages(), identity: 'c', fields: { name: 'subject' }, conflicts: 'latest' }))
		).toThrow(/always one-way/);
		// A remote field the record schema does not have is refused at sync, where types cannot see.
		expect(() =>
			describeIntegration('erp', sync({ direction: 'one_way', source: readOnly, identity: 'c', fields: { name: 'nickname' } }))
		).toThrow(/does not have/);
	});

	it('types what a sync may say', () => {
		if (false) {
			defineIntegration<S, { accounts: typeof Customer.Type }>({
				policies: ['p'],
				syncs: {
					// @ts-expect-error a two-way sync over a source without create/update/delete.
					accounts: { direction: 'two_way', source: readOnly, identity: 'external_code', fields: {}, conflicts: 'latest' }
				}
			});
			defineIntegration<S, { accounts: typeof Customer.Type }>({
				policies: ['p'],
				syncs: {
					// @ts-expect-error a two-way sync must state its conflict rule.
					accounts: { direction: 'two_way', source: writable, identity: 'external_code', fields: {} }
				}
			});
			defineIntegration<S, { accounts: typeof Customer.Type }>({
				policies: ['p'],
				syncs: {
					accounts: {
						direction: 'one_way',
						source: readOnly,
						identity: 'external_code',
						// @ts-expect-error `nickname` is not a field of the source's record.
						fields: { name: 'nickname' }
					}
				}
			});
		}
		expect(true).toBe(true);
	});
});

describe('what the browser may write to a synced collection', () => {
	const write = {
		create: { columns: { code: true as const, name: true as const, currency: true as const, note: true as const } },
		update: { columns: { code: true as const, name: true as const, currency: true as const, note: true as const } },
		delete: true as const
	};
	const sync = (overrides: Record<string, unknown>) =>
		({
			name: 'erp.accounts',
			collection: 'accounts',
			direction: 'one_way',
			source: 'http',
			capabilities: ['list'],
			identity: 'code',
			fields: [
				{ column: 'name', remote: 'name', pushed: false },
				{ column: 'currency', remote: 'currency', pushed: false }
			],
			owns: { remote: [], local: [] },
			conflicts: { default: 'remote_wins', fields: {} },
			deletes: 'delete_wins',
			onUnmatchedLocal: 'report',
			...overrides
		}) as never;

	it('offers a mirror only its local-only columns, and no create or delete', () => {
		expect(browserWrite(write, [sync({})])).toEqual({ update: { columns: { note: true } } });
	});

	it('leaves a two-way collection writable except the identity and what the remote owns', () => {
		expect(
			browserWrite(write, [
				sync({
					direction: 'two_way',
					fields: [
						{ column: 'name', remote: 'name', pushed: true },
						{ column: 'currency', remote: 'currency', pushed: true }
					],
					owns: { remote: ['currency'], local: [] }
				})
			])
		).toEqual({
			create: { columns: { name: true, note: true } },
			update: { columns: { name: true, note: true } },
			delete: true
		});
	});

	it('changes nothing for a collection no sync touches', () => {
		expect(browserWrite(write, [])).toBe(write);
	});
});
