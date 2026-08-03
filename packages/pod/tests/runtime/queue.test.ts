import { describe, expect, it } from 'vitest';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import type { HostMessagingBinding } from '@norbital-ai/platform-utils/runtime/binding';
import { workspaceJobs } from '../../src/host/jobs.js';
import { intervalQueue } from '../../src/host/interval-queue.js';

/** A `messaging` binding that only has to deliver on the `email` channel. */
function messagingBinding(binding: Pick<HostMessagingBinding, 'send'>): HostMessagingBinding {
	return {
		listChannels: async () => ['email'],
		send: binding.send,
		listTransports: async () => [],
		sendVia: async () => ({ sent: false, reason: 'no transports' })
	};
}

function manifest(schedule: string): NorbitalManifest {
	return {
		version: 1,
		collections: {},
		relationships: {},
		automations: {
			job: {
				trigger: { schedule }
			}
		}
	};
}

async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for the queue');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('workspace jobs', () => {
	it('refuses an invalid schedule before starting a partial runtime', () => {
		expect(() =>
			workspaceJobs({
				manifest: manifest('not a schedule'),
				dispatch: async () => undefined,
				organizationId: 'org-1'
			})
		).toThrow(/invalid schedule/);
	});

	it('derives one job per scheduled automation and one per configured outbox', () => {
		const jobs = workspaceJobs({
			manifest: manifest('* * * * *'),
			dispatch: async () => undefined,
			organizationId: 'org-1',
			messaging: messagingBinding({ send: async () => ({ sent: true }) })
		});
		expect(jobs.map((job) => job.name)).toEqual(['pod:automation:job', 'pod:notification-outbox']);
		// A host that supplies no delivery provider gets no drain job to run.
		const bare = workspaceJobs({
			manifest: manifest('* * * * *'),
			dispatch: async () => undefined,
			organizationId: 'org-1'
		});
		expect(bare.map((job) => job.name)).toEqual(['pod:automation:job']);
	});

	it('does not let a slow automation block transactional notification delivery', async () => {
		let finishAutomation!: () => void;
		const automation = new Promise<void>((resolve) => {
			finishAutomation = resolve;
		});
		let claimed = false;
		let delivered = false;
		let sentOrganization = '';
		const jobs = workspaceJobs({
			manifest: manifest('* * * * *'),
			organizationId: 'org-1',
			messaging: messagingBinding({
				async send(input) {
					sentOrganization = input.organizationId;
					return { sent: true };
				}
			}),
			async dispatch(request) {
				const input = request as { kind?: string; action?: string };
				if (input.kind === 'automation') return automation;
				if (input.kind === 'notification' && input.action === 'claim' && !claimed) {
					claimed = true;
					return [
						{
							norbital_id: '11111111-1111-4111-8111-111111111111',
							channel: 'email',
							recipient_user_id: '22222222-2222-4222-8222-222222222222',
							subject: 'Ready',
							message: 'The write committed.',
							cta_label: null,
							cta_url: null,
							attempts: 1
						}
					];
				}
				if (input.kind === 'notification' && input.action === 'delivered') {
					delivered = true;
				}
				return [];
			}
		});
		const stop = await intervalQueue({ intervalMs: 1000, log: () => {} })(jobs);
		try {
			await eventually(() => delivered);
			expect(sentOrganization).toBe('org-1');
		} finally {
			finishAutomation();
			stop();
		}
	});
});

describe('interval queue', () => {
	it('never runs one job name concurrently with itself', async () => {
		let running = 0;
		let maxConcurrent = 0;
		let starts = 0;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});

		const stop = await intervalQueue({ intervalMs: 10, log: () => {} })([
			{
				name: 'pod:drain',
				schedule: 'continuous',
				async run() {
					starts += 1;
					running += 1;
					maxConcurrent = Math.max(maxConcurrent, running);
					await blocked;
					running -= 1;
				}
			}
		]);

		try {
			// Many sweeps elapse while the first run is still blocked; the drain must not be re-entered,
			// or two passes would claim the same outbox rows.
			await new Promise((resolve) => setTimeout(resolve, 120));
			expect(starts).toBe(1);
			expect(maxConcurrent).toBe(1);
		} finally {
			release();
			stop();
		}
	});

	it('runs a cron job at most once per matching minute', async () => {
		let runs = 0;
		const stop = await intervalQueue({ intervalMs: 10, log: () => {} })([
			{
				name: 'pod:automation:job',
				schedule: '* * * * *',
				run: async () => {
					runs += 1;
				}
			}
		]);
		try {
			await eventually(() => runs > 0);
			await new Promise((resolve) => setTimeout(resolve, 120));
			expect(runs).toBe(1);
		} finally {
			stop();
		}
	});

	it('keeps sweeping after a job throws', async () => {
		let drained = 0;
		const stop = await intervalQueue({ intervalMs: 10, log: () => {} })([
			{
				name: 'pod:broken',
				schedule: 'continuous',
				run: async () => {
					throw new Error('provider is down');
				}
			},
			{
				name: 'pod:healthy',
				schedule: 'continuous',
				run: async () => {
					drained += 1;
				}
			}
		]);
		try {
			await eventually(() => drained >= 2);
		} finally {
			stop();
		}
	});
});
