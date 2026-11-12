// The device wall's checks (shell/device-access.ts): a native host's providers decide; foreground-only location does not
// satisfy `location:background`; a refused native permission is only fixed in the phone's settings.
import { required } from './support/required.ts';
import { describe, expect, it, vi } from '@effect/vitest';
import { Effect } from 'effect';
import { deviceAccess } from '../src/shell/device-access.ts';
import type { DeviceApi } from '../src/page/device.ts';

const native = (always: boolean, enabled = true): DeviceApi => ({
	geolocation: {
		source: 'native',
		api: { getCurrentPosition: vi.fn(), watchPosition: vi.fn(() => 1), clearWatch: vi.fn() },
		background: {
			status: async () => ({ enabled, always }),
			open_settings: vi.fn(async () => undefined)
		}
	},
	notifications: {
		status: async () => 'denied',
		request: vi.fn(async () => 'denied' as const),
		open_settings: vi.fn(async () => undefined),
		show: async () => undefined,
		on_open: () => () => undefined
	}
});

describe('device access', () => {
	it.effect(
		'needs always-on location for background tracking, and sends a refusal to the settings',
		() =>
			Effect.gen(function* () {
				const d = deviceAccess(native(false));
				expect(yield* d.check('location')).toEqual({ state: 'granted', settings: true });
				expect(yield* d.check('location:background')).toEqual({ state: 'denied', settings: true });
				expect(yield* deviceAccess(native(true)).check('location:background')).toEqual({
					state: 'granted',
					settings: true
				});
			})
	);

	it.effect('asks a native host for notifications, and opens its settings once refused', () =>
		Effect.gen(function* () {
			const f = native(true);
			const d = deviceAccess(f);
			expect(yield* d.check('notifications')).toEqual({ state: 'denied', settings: true });
			yield* d.open_settings('notifications');
			expect(required(f.notifications).open_settings).toHaveBeenCalled();
		})
	);

	it.effect('falls back to the browser, and says so when it cannot provide a permission', () =>
		Effect.gen(function* () {
			const d = deviceAccess({});
			expect((yield* d.check('location')).state).toBe('unsupported');
			expect((yield* d.check('camera')).state).toBe('unsupported');
		})
	);
});
