import { beforeEach, describe, expect, it } from 'vitest';
import NotificationsMenu from '$lib/runtime/notifications-menu.svelte';
import SidebarHarness from '../support/sidebar-harness.svelte';
import { FakeReplica } from '../support/fake-replica.svelte.js';
import { render, settle } from '../support/component.js';

const ME = 'user-me';
const SOMEONE_ELSE = 'user-other';

let replica = new FakeReplica();

function notification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		norbital_id: 'n1',
		recipient_user_id: ME,
		subject: 'RFI raised',
		message: 'Waiting on your answer.',
		cta_label: null,
		cta_url: null,
		notification_category: 'rfi',
		read_at: null,
		norbital_created_at: '2026-07-31T09:00:00.000Z',
		...overrides
	};
}

beforeEach(() => {
	replica = new FakeReplica();
});

function mountBell(): { container: HTMLElement; destroy(): void } {
	return render(
		SidebarHarness as never,
		{
			component: NotificationsMenu,
			props: { workspaceApi: replica, userId: ME, expanded: true }
		} as never
	);
}

function badge(): string | null {
	return (
		document.querySelector('[data-testid="notification-unread-badge"]')?.textContent?.trim() ?? null
	);
}

function bell(): HTMLElement {
	const trigger = document.querySelector('[aria-label^="Notifications"]');
	if (!(trigger instanceof HTMLElement)) throw new Error('bell missing');
	return trigger;
}

function listedSubjects(): string[] {
	return [...document.querySelectorAll('li button .truncate')].map(
		(node) => node.textContent?.trim() ?? ''
	);
}

describe('notifications bell', () => {
	it('counts what is unread in the replica, not what this session has seen', async () => {
		replica.seed('notification', [
			notification({ norbital_id: 'n1' }),
			notification({ norbital_id: 'n2', subject: 'Approval waiting' }),
			notification({
				norbital_id: 'n3',
				subject: 'Read already',
				read_at: '2026-07-30T00:00:00.000Z'
			})
		]);
		const { destroy } = mountBell();
		await settle();

		expect(badge()).toBe('2');
		expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 unread');
		destroy();
	});

	it('counts one raised while it was on screen, with nothing clicked', async () => {
		replica.seed('notification', [notification()]);
		const { destroy } = mountBell();
		await settle();
		expect(badge()).toBe('1');

		// A hook, an automation or an inbound channel wrote this. Nothing here polls for it; the sync
		// engine re-fires the read the bell already has open.
		replica.arrive('notification', {
			...notification({ norbital_id: 'n2' }),
			subject: 'Delivery late'
		});
		await settle();

		expect(badge()).toBe('2');
		destroy();
	});

	it('leaves another person’s notification out of this bell', async () => {
		replica.seed('notification', [notification()]);
		const { destroy } = mountBell();
		await settle();

		replica.arrive('notification', {
			...notification({ norbital_id: 'n2' }),
			recipient_user_id: SOMEONE_ELSE,
			subject: 'Not for you'
		});
		await settle();

		// The server guard scopes replication, but an admin session short-circuits the policy deny —
		// the `where` on the query is what keeps this from becoming a workspace-wide firehose.
		expect(badge()).toBe('1');
		bell().click();
		await settle();
		expect(listedSubjects()).toEqual(['RFI raised']);
		destroy();
	});

	it('drops the count when the list is opened and marked read', async () => {
		replica.seed('notification', [
			notification({ norbital_id: 'n1' }),
			notification({
				norbital_id: 'n2',
				subject: 'Approval waiting',
				norbital_created_at: '2026-07-31T11:00:00.000Z'
			})
		]);
		const { destroy } = mountBell();
		await settle();
		expect(badge()).toBe('2');

		bell().click();
		await settle();
		// Newest first, as the query asks for.
		expect(listedSubjects()).toEqual(['Approval waiting', 'RFI raised']);

		const markAll = [...document.querySelectorAll('button')].find(
			(node) => node.textContent?.trim() === 'Mark all read'
		);
		expect(markAll).toBeDefined();
		markAll?.click();
		await settle();

		// One write per row through the ordinary mutate path — `updateMany` would neither apply
		// locally nor be authorized by the self-service rule that lets a recipient dismiss their own.
		expect(replica.writes.map((write) => write.id).sort()).toEqual(['n1', 'n2']);
		expect(replica.writes.every((write) => typeof write.patch.read_at === 'string')).toBe(true);
		// And the badge follows the replica back down rather than being cleared by the click.
		expect(badge()).toBeNull();
		destroy();
	});
});
