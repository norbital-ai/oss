import { describe, it, expect } from 'vitest';
import {
	matchChangeAutomations,
	eventForAction,
	INTERACTIVE_AGENT_AUTOMATION_NAME,
	GUEST_ADMIT_ARTIFACT_MARKER
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
	// Behavioral coverage for admitAgentTurn and the guest reducer lives in
	// agent-live-capabilities-e2e.test.ts and ../standalone/channel-delivery-e2e.test.ts.
	it('exports the interactive job sentinel used by guest admit', () => {
		expect(INTERACTIVE_AGENT_AUTOMATION_NAME).toBe('agent:interactive');
		expect(GUEST_ADMIT_ARTIFACT_MARKER).toBe('guest-admit');
	});
	it('keeps tenant receipts narrow while DBOS owns leases and retries', () => {
		const source = readFileSync(
			new URL('../../src/server/run/automation-dispatch.server.ts', import.meta.url),
			'utf8'
		);
		expect(source).toContain('ON CONFLICT (automation_name, trigger_key) DO NOTHING');
		expect(source).not.toContain('FOR UPDATE SKIP LOCKED');
		expect(source).not.toContain('lease_until');
		expect(source).not.toContain('AUTOMATION_JOB_MAX_ATTEMPTS');
		expect(source).toContain("status = 'waiting_effect'");
		expect(source).toContain('continuation = $2::jsonb');
		expect(source).toContain('record_snapshot');
		expect(source).toContain('checkpoint_id');
		expect(source).toContain('runtime_version');
		expect(source).toContain('GUEST_ADMIT_ARTIFACT_MARKER');
		expect(source).toContain('admitAgentTurn');
		expect(source).toContain('receiptUsesAgentReducer');
	});
});

describe('durable agent automations', () => {
	it('routes interactive and channel agent jobs through receipts instead of refusing the handler', () => {
		const source = readFileSync(
			new URL('../../src/server/run/tenant_run.ts', import.meta.url),
			'utf8'
		);
		expect(source).not.toContain('cannot complete inside one guest invocation');
		expect(source).not.toContain("spec.kind === 'agent'");
		expect(source).toContain('runDurableAgentAutomation');
		expect(source).toContain("agent:interactive");
	});
});
