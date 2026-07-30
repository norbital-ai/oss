import { describe, expect, it } from 'vitest';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { startScheduler } from '../../src/lib/bin/invocation/scheduler.js';

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
		if (Date.now() >= deadline) throw new Error('Timed out waiting for scheduler');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('standalone scheduler', () => {
	it('refuses an invalid schedule before starting a partial runtime', () => {
		expect(() =>
			startScheduler({
				manifest: manifest('not a schedule'),
				dispatch: async () => undefined,
				automations: true,
				organizationId: 'org-1',
				intervalMs: 60_000
			})
		).toThrow(/invalid schedule/);
	});

	it('does not let a slow automation block transactional notification delivery', async () => {
		let finishAutomation!: () => void;
		const automation = new Promise<void>((resolve) => {
			finishAutomation = resolve;
		});
		let claimed = false;
		let delivered = false;
		let sentOrganization = '';
		const scheduler = startScheduler({
			manifest: manifest('* * * * *'),
			automations: true,
			organizationId: 'org-1',
			intervalMs: 60_000,
			notifications: {
				channels: ['email'],
				async send(input) {
					sentOrganization = input.organizationId;
					return { sent: true };
				}
			},
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
		try {
			await eventually(() => delivered);
			expect(sentOrganization).toBe('org-1');
		} finally {
			finishAutomation();
			scheduler.stop();
		}
	});
});
