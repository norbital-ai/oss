import { describe, expect, it } from 'vitest';
import { install } from '../src/decl/runtime/guest.ts';
import { app, automation, group, integration, mcp, model, workspace } from '../src/index.ts';
import * as rt from './types/fixture/runtime.ts';
import * as models from './types/fixture/models.ts';
import './types/registry.ts';

install();
const original = (body: object | undefined): unknown =>
	body === undefined
		? undefined
		: Object.getOwnPropertyDescriptor(body, Symbol.for('norbital.bolt.generator'))?.value;

describe('runtime declarations', () => {
	it('keeps body-free declarations as their authored data', () => {
		const ws = {
			tz: 'UTC',
			locale: 'en',
			connections: { mail: { integration: 'email' } }
		} as const;
		expect(workspace(ws)).toBe(ws);
		const server = { description: 'Docs', url: 'MCP_URL' } as const;
		expect(mcp(server)).toBe(server);
	});

	it('keeps app and group literals and attaches automation bodies', () => {
		expect(
			app({
				title: 'Portal',
				description: 'Portal',
				icon: 'x',
				pages: { tickets: { title: 'Tickets' } }
			}).pages.tickets.title
		).toBe('Tickets');
		expect(group({ title: 'Ops', icon: 'x', default_child: 'sales' }).default_child).toBe('sales');
		const declared = automation(rt.nightly.spec);
		expect(declared.spec).toBe(rt.nightly.spec);
		expect(original(declared.body)).toBe(rt.nightly.spec.run);
		const submitted = automation(rt.orders_submit.spec);
		expect(submitted.spec.policies).toEqual(['sales_rep']);
		expect(original(submitted.body)).toBe(rt.orders_submit.spec.run);
	});

	it('wraps an integration pairing test from its inline literal', () => {
		const test = function* () {};
		const declared = integration('kingdee', { ...rt.kingdee.spec, test });
		expect(declared.name).toBe('kingdee');
		expect(declared.spec.driver).toBe('sqlserver');
		expect(original(declared.bodies.test)).toBe(test);
		expect(integration('support_mail', rt.support_mail.spec).bodies).toEqual({});
	});

	it('keeps file sync bodies on their model and remote connection data on the integration', () => {
		const read = function* () {
			return { rows: [] };
		};
		const write = function* () {
			return [];
		};
		const declared = model('notice_notes', {
			...models.notice_notes.spec,
			syncs: {
				sheet: {
					with: 'file',
					parser: ['csv'],
					schema: { code: { kind: 'text' }, note: { kind: 'text' } },
					context: { notice: { kind: 'id', of: 'notices' } },
					read,
					write
				}
			}
		});
		expect(original(declared.bodies.syncs['sheet']?.read)).toBe(read);
		expect(original(declared.bodies.syncs['sheet']?.write)).toBe(write);
		expect(declared.bodies.syncs['sheet']?.parse).toEqual({});
		expect(rt.kingdee.spec).not.toHaveProperty('syncs');
	});
});
