import { runInNewContext } from 'node:vm';
import { expect, it, vi } from '@effect/vitest';
import { PUSH_WORKER } from '../src/shell/push-worker.ts';

type WindowClient = { readonly url: string; readonly focused: boolean; readonly visibilityState: 'visible' | 'hidden' };
type WorkerEvent = {
	readonly waitUntil: (work: Promise<unknown>) => void;
	readonly data?: { readonly json: () => { id: string; title: string; body: string; path: string } };
	readonly notification?: { readonly close: () => void; readonly data: { readonly url: string } };
};
const worker = (windows: readonly WindowClient[] = []) => {
	const events = new Map<string, (event: WorkerEvent) => void>();
	const showNotification = vi.fn(async () => undefined), openWindow = vi.fn(async () => undefined),
		skipWaiting = vi.fn(async () => undefined), claim = vi.fn(async () => undefined);
	runInNewContext(PUSH_WORKER, { URL, self: {
		addEventListener: (name: string, listener: (event: WorkerEvent) => void) => events.set(name, listener),
		skipWaiting,
		registration: { scope: 'https://app.example/workspace/', showNotification },
		clients: { matchAll: async () => windows, openWindow, claim }
	} });
	const fire = async (name: string, detail: Omit<WorkerEvent, 'waitUntil'> = {}) => {
		const listener = events.get(name);
		if (listener === undefined) throw new Error(`Missing worker ${name} listener`);
		const pending: Promise<unknown>[] = [];
		listener({ ...detail, waitUntil: (work) => { pending.push(work); } });
		await Promise.all(pending);
	};
	return { fire, showNotification, openWindow, skipWaiting, claim };
};
const data = { json: () => ({ id: 'notice-1', title: 'Report ready', body: 'Open your report', path: '/inbox?record=reports/1' }) };

it('activates and claims clients so the first permitted subscription can become active', async () => {
	const host = worker();
	await host.fire('install');
	await host.fire('activate');
	expect(host.skipWaiting).toHaveBeenCalledOnce();
	expect(host.claim).toHaveBeenCalledOnce();
});

it('shows background pushes with a stable notice tag and a workspace-scoped click target', async () => {
	for (const windows of [
		[],
		[{ url: 'https://app.example/workspace/inbox', focused: false, visibilityState: 'hidden' }],
		[{ url: 'https://app.example/workspace/inbox', focused: false, visibilityState: 'visible' }],
		[{ url: 'https://app.example/other/inbox', focused: true, visibilityState: 'visible' }],
		[{ url: 'https://app.example/workspace-other/inbox', focused: true, visibilityState: 'visible' }]
	] satisfies readonly (readonly WindowClient[])[]) {
		const host = worker(windows);
		await host.fire('push', { data });
		expect(host.showNotification).toHaveBeenCalledWith('Report ready', {
			tag: 'notice-1', body: 'Open your report', data: { url: 'https://app.example/workspace/inbox?record=reports/1' }
		});
	}
	const foreground = worker([{ url: 'https://app.example/workspace/inbox', focused: true, visibilityState: 'visible' }]);
	await foreground.fire('push', { data });
	expect(foreground.showNotification).not.toHaveBeenCalled();
	const host = worker(), close = vi.fn();
	await host.fire('notificationclick', { notification: { close, data: { url: 'https://app.example/workspace/inbox?record=reports/1' } } });
	expect(close).toHaveBeenCalledOnce();
	expect(host.openWindow).toHaveBeenCalledWith('https://app.example/workspace/inbox?record=reports/1');
});
