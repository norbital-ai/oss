import { describe, expect, it } from 'vitest';
import * as bolt from '../src/index.ts';
import { app, automation, channel, connection, envoy, group, integration, mcp, pipeline, workspace } from '../src/index.ts';
import * as rt from './types/fixture/runtime.ts';
import './types/registry.ts';

describe('next runtime declarations', () => {
	it('exports the runtime declaration functions (P29)', () => {
		for (const name of ['workspace', 'app', 'group', 'integration', 'pipeline', 'envoy', 'mcp', 'automation', 'channel', 'connection'])
			expect(typeof (bolt as Record<string, unknown>)[name]).toBe('function');
	});

	it('literal declarations return their literal: declarations are data', () => {
		const ws = { tz: 'UTC', locale: 'en' } as const;
		expect(workspace(ws)).toBe(ws);
		const conn = { baseUrl: 'ERP_URL', auth: { bearer: 'ERP_TOKEN' } } as const;
		expect(connection(conn)).toBe(conn);
		const ch = { transport: 'whatsapp' } as const;
		expect(channel(ch)).toBe(ch);
		const en = { channel: 'whatsapp', audience: 'public', name: 'Norbius', policies: ['sales_rep'], delegation: 'disabled', task: 't' } as const;
		expect(envoy(en)).toBe(en);
		const m = { description: 'docs', url: 'MCP_URL' } as const;
		expect(mcp(m)).toBe(m);
	});

	it('per-collection and per-folder declarations carry their name', () => {
		expect(rt.customers_integration.name).toBe('customers');
		expect(rt.customers_integration.spec.direction).toBe('two_way');
		expect(rt.orders_pipeline.name).toBe('orders');
		expect(integration('notices', { direction: 'one_way', policies: ['sales_rep'], source: { channel: 'support' }, identity: 'message_id', fields: {} }).name).toBe('notices');
		expect(pipeline('orders', { export: { description: 'x', select: ['number'], format: 'csv' } }).spec.export?.format).toBe('csv');
		expect(app('portal', { title: 'P', description: 'P', icon: 'x', pages: { tickets: { title: 'T' } } }).name).toBe('portal');
		expect(group('ops', { label: 'Ops', icon: 'x', defaultChild: 'sales' }).spec.defaultChild).toBe('sales');
	});

	it('an automation keeps its literal and takes its run body exactly once', async () => {
		const a = automation({ description: 'x', runAs: ['sales_rep'], on: { created: 'orders' }, output: { kind: 'int' } });
		expect(a.spec.on).toEqual({ created: 'orders' });
		expect(a.body).toBeUndefined();
		const body = async ({ ids }: { readonly ids: readonly unknown[] }) => ids.length;
		a.run(body);
		expect(a.body).toBe(body);
		expect(() => a.run(body)).toThrow('run is attached twice');
		expect(rt.nightly.body).toBeTypeOf('function');
	});

	it('channel callbacks are pure functions of their argument', () => {
		const outbound = rt.support.outbound?.confirmations;
		expect(outbound?.from).toBe('orders');
		const record = { number: 'SO-0001', note: null, id: 'o1' } as unknown as Parameters<NonNullable<typeof outbound>['message']>[0]['record'];
		expect(outbound?.message({ record })).toEqual({ to: ['sales@example.com'], subject: 'Order SO-0001', text: '', thread: 'o1' });
		const events = rt.support.events;
		const bounced = typeof events === 'object' ? events.bounced : undefined;
		expect(bounced?.({ at: 'now', message: 'm', reason: 'mailbox full' } as unknown as Parameters<NonNullable<typeof bounced>>[0])).toEqual({ note: 'mailbox full' });
	});
});
