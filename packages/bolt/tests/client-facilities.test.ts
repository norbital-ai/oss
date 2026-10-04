import { afterEach, expect, it, vi } from 'vitest';
import { clientFacilities } from '../src/client/facilities.ts';
afterEach(() => vi.unstubAllGlobals());
it('prefers optional native facilities, retains browser support and reports absence', () => {
	const browser = { watchPosition: vi.fn() } as unknown as Geolocation;
	const native = { watchPosition: vi.fn() } as unknown as Geolocation;
	vi.stubGlobal('navigator', { geolocation: browser });
	vi.stubGlobal('window', {});
	expect(clientFacilities().geolocation).toEqual({ source: 'browser', api: browser });
	vi.stubGlobal('window', {
		boltHostFacilities: { geolocation: { source: 'native', api: native } }
	});
	expect(clientFacilities().geolocation).toEqual({ source: 'native', api: native });
	expect(
		clientFacilities({ geolocation: { source: 'browser', api: browser } }).geolocation?.api
	).toBe(native);
	expect(
		clientFacilities({ geolocation: { source: 'native', api: native } }).geolocation?.api
	).toBe(native);
	vi.stubGlobal('window', {});
	vi.stubGlobal('navigator', {});
	expect(clientFacilities()).toEqual({});
	vi.stubGlobal('navigator', undefined);
	vi.stubGlobal('window', undefined);
	expect(clientFacilities()).toEqual({});
});
