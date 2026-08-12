import { describe, it, expect } from 'vitest';
import {
	matchChangeAutomations,
	eventForAction
} from '$lib/server/run/automation-dispatch.server.js';
import { readFileSync } from 'node:fs';

const automations = {
	notify_on_new_order: { trigger: { trigger: { collection: 'orders', event: 'created' } } },
	audit_order_change: { trigger: { trigger: { collection: 'orders', event: 'updated' } } },
	sweep_customers: { trigger: { trigger: { collection: 'customers', event: 'deleted' } } },
	nightly: { trigger: { schedule: '0 0 * * *' } } // cron, never a change match
};

describe('automation-dispatch matcher', () => {
	it('maps actions to change events', () => {
		expect(eventForAction('create')).toBe('created');
		expect(eventForAction('update')).toBe('updated');
		expect(eventForAction('delete')).toBe('deleted');
	});

	it('matches automations by collection + event', () => {
		expect(matchChangeAutomations(automations, 'orders', 'created')).toEqual([
			'notify_on_new_order'
		]);
		expect(matchChangeAutomations(automations, 'orders', 'updated')).toEqual([
			'audit_order_change'
		]);
		expect(matchChangeAutomations(automations, 'customers', 'deleted')).toEqual([
			'sweep_customers'
		]);
	});

	it('ignores non-matching collections/events and schedule triggers', () => {
		expect(matchChangeAutomations(automations, 'orders', 'deleted')).toEqual([]);
		expect(matchChangeAutomations(automations, 'invoices', 'created')).toEqual([]);
		expect(matchChangeAutomations({}, 'orders', 'created')).toEqual([]);
		expect(matchChangeAutomations(undefined, 'orders', 'created')).toEqual([]);
	});
});

describe('durable automation jobs', () => {
	it('separates idempotent enqueue from leased, retried execution', () => {
		const source = readFileSync(
			new URL('../../src/server/run/automation-dispatch.server.ts', import.meta.url),
			'utf8'
		);
		expect(source).toContain('ON CONFLICT (automation_name, event_xid, event_seq) DO NOTHING');
		expect(source).toContain('FOR UPDATE SKIP LOCKED');
		expect(source).toContain("status = 'processing' AND lease_until <= CURRENT_TIMESTAMP");
		expect(source).toContain('AUTOMATION_JOB_MAX_ATTEMPTS = 5');
		expect(source).toContain('AUTOMATION_JOB_CONCURRENCY = 1');
		expect(source).toContain('AUTOMATION_JOB_HEARTBEAT_SECONDS = 30');
		expect(source).toContain("norbital_id = $1::uuid AND status = 'processing'");
	});
});
