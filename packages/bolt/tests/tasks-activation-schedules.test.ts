import { describe, expect, it } from 'vitest';
import { ActivationCommands } from '../src/runtime/app.js';
import type { WorkspaceDefinition } from '../src/authoring/workspace-schema.js';

/**
 * What activation writes into `bolt_schedule`: every cron a release declares, and nothing else.
 * A schedule that stops existing raises nothing, so the set is asserted outright.
 */
const workspace = (overrides: Partial<WorkspaceDefinition>): WorkspaceDefinition =>
	({
		name: 'schedules',
		collections: [],
		customTypes: {},
		policies: [],
		relations: [],
		automations: [],
		channels: [],
		envoys: [],
		integrations: [],
		...overrides
	}) as unknown as WorkspaceDefinition;

describe('activation schedules', () => {
	it('registers every automation for manual invocation while scheduling only cron declarations', () => {
		const declared = workspace({
			automations: [
				{ name: 'manual_only', trigger: { _tag: 'Manual' }, policies: [], command: 'automations.manual_only' },
				{ name: 'nightly', trigger: { _tag: 'Schedule', cron: '0 0 * * *' }, policies: [], command: 'automations.nightly' },
				{
					name: 'on_change',
					trigger: { _tag: 'Change', collection: 'records', event: 'updated' },
					policies: [],
					command: 'automations.on_change'
				}
			]
		});
		expect(ActivationCommands.forWorkspace(declared).map(({ key }) => key)).toEqual(
			expect.arrayContaining(['automations.manual_only', 'automations.nightly', 'automations.on_change'])
		);
		expect(ActivationCommands.schedulesFor(declared, 'test-tenant').map(({ key }) => key)).toEqual([
			'automations.nightly'
		]);
	});

	it('schedules each sync to reconcile, and to poll only when its source has changes', () => {
		const sync = (name: string, changesSchedule?: string) => ({
			name,
			collection: name,
			direction: 'one_way' as const,
			source: 'http' as const,
			capabilities: [],
			identity: 'code',
			fields: [],
			owns: { remote: [], local: [] },
			conflicts: { default: 'remote_wins' as const, fields: {} },
			deletes: 'delete_wins' as const,
			onUnmatchedLocal: 'report' as const,
			reconcileSchedule: '0 3 * * *',
			webhook: false,
			...(changesSchedule === undefined ? {} : { changesSchedule })
		});
		const declared = workspace({
			integrations: [{ name: 'erp', policies: ['p'], syncs: [sync('accounts', '*/5 * * * *'), sync('products')] }]
		});
		expect(
			ActivationCommands.schedulesFor(declared, 'test-tenant').map(({ key, crontab, input }) => ({ key, crontab, input }))
		).toEqual([
			{
				key: 'integrations.run:erp.accounts:changes',
				crontab: '*/5 * * * *',
				input: { integration: 'erp', sync: 'accounts', mode: 'changes' }
			},
			{
				key: 'integrations.run:erp.accounts:reconcile',
				crontab: '0 3 * * *',
				input: { integration: 'erp', sync: 'accounts', mode: 'reconcile' }
			},
			{
				key: 'integrations.run:erp.products:reconcile',
				crontab: '0 3 * * *',
				input: { integration: 'erp', sync: 'products', mode: 'reconcile' }
			}
		]);
		// Outbound work is enqueued by the write that causes it: no drain is scheduled.
		expect(ActivationCommands.forWorkspace(declared).map(({ key }) => key)).toEqual(
			expect.arrayContaining(['channels.drain', 'integrations.push', 'integrations.run', 'webhooks.receive'])
		);
	});
});
