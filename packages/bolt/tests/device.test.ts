// The device wall's checks (shell/device.ts): a native host's providers decide; foreground-only location does not
// satisfy `location:background`; a refused native permission is only fixed in the phone's settings.
import { describe, expect, it, vi } from 'vitest';
import { device } from '../src/shell/device.ts';
import type { ClientFacilities } from '../src/client/facilities.ts';

const native = (always: boolean, enabled = true): ClientFacilities => ({
	geolocation: {
		source: 'native',
		api: {} as Geolocation,
		background: { status: async () => ({ enabled, always }), openSettings: vi.fn(async () => undefined) }
	},
	notifications: { status: async () => 'denied', request: vi.fn(async () => 'denied' as const), openSettings: vi.fn(async () => undefined) }
});

describe('device access', () => {
	it('needs always-on location for background tracking, and sends a refusal to the settings', async () => {
		const d = device(native(false));
		expect(await d.check('location')).toEqual({ state: 'granted', settings: true });
		expect(await d.check('location:background')).toEqual({ state: 'denied', settings: true });
		expect(await device(native(true)).check('location:background')).toEqual({ state: 'granted', settings: true });
	});

	it('asks a native host for notifications, and opens its settings once refused', async () => {
		const f = native(true);
		const d = device(f);
		expect(await d.check('notifications')).toEqual({ state: 'denied', settings: true });
		await d.openSettings('notifications');
		expect(f.notifications!.openSettings).toHaveBeenCalled();
	});

	it('falls back to the browser, and says so when it cannot provide a permission', async () => {
		const d = device({});
		expect((await d.check('location')).state).toBe('unsupported');
		expect((await d.check('camera')).state).toBe('unsupported');
	});
});
