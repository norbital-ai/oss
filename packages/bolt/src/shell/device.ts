// Device access an app declares in `requires` (decl/runtime/app.ts): each requirement's state on this device, how to
// ask for it, and whether only the device's settings can still grant it. A native host's providers (ClientFacilities)
// win; otherwise the browser's own permission APIs answer. Availability grants no server authority.
import type { Access, ClientFacilities } from '../client/facilities.ts';
import type { DeviceRequirement } from '../decl/runtime/app.ts';

export type DeviceState = { readonly state: Access | 'unsupported'; readonly settings: boolean };
export type Device = {
	check(r: DeviceRequirement): Promise<DeviceState>;
	request(r: DeviceRequirement): Promise<void>;
	openSettings(r: DeviceRequirement): Promise<void>;
};

const query = async (name: string): Promise<Access | null> => {
	try {
		const s = await navigator.permissions.query({ name } as unknown as PermissionDescriptor);
		return s.state;
	} catch {
		return null; // a browser that cannot name this permission: asking is the only way to know
	}
};
/** Access proven this session (a stream, a fix): a browser cannot always say so through `permissions.query`. */
const proven = new Set<'camera' | 'location'>();
const position = (geo: Geolocation) =>
	new Promise<boolean>((resolve) =>
		geo.getCurrentPosition(() => resolve(true), () => resolve(false), { timeout: 15_000 }));

export function device(f: ClientFacilities): Device {
	const geo = f.geolocation;
	const browserNotify = typeof Notification !== 'undefined';
	const browserCamera = typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined;
	const native = (r: DeviceRequirement) => (r === 'notifications' ? f.notifications : r === 'camera' ? f.camera : undefined);
	async function check(r: DeviceRequirement): Promise<DeviceState> {
		const n = native(r);
		if (n !== undefined) return { state: await n.status(), settings: true };
		if (r === 'location' || r === 'location:background') {
			if (geo === undefined) return { state: 'unsupported', settings: false };
			if (geo.source === 'native' && geo.background !== undefined) {
				const b = await geo.background.status().catch(() => ({ enabled: false, always: false }));
				// foreground-only is not enough for background tracking: only the phone's settings can make it "always"
				if (r === 'location:background' && b.enabled && !b.always) return { state: 'denied', settings: true };
				if (b.enabled && (b.always || r === 'location')) return { state: 'granted', settings: true };
			}
			if (proven.has('location')) return { state: 'granted', settings: false };
			return { state: (await query('geolocation')) ?? 'prompt', settings: geo.source === 'native' };
		}
		if (r === 'notifications')
			return browserNotify
				? { state: Notification.permission === 'default' ? 'prompt' : Notification.permission, settings: false }
				: { state: 'unsupported', settings: false };
		if (!browserCamera) return { state: 'unsupported', settings: false };
		return { state: proven.has('camera') ? 'granted' : ((await query('camera')) ?? 'prompt'), settings: false };
	}
	async function request(r: DeviceRequirement): Promise<void> {
		const n = native(r);
		if (n !== undefined) return void (await n.request());
		if (r === 'location' || r === 'location:background') {
			if (geo !== undefined && (await position(geo.api))) proven.add('location');
			return;
		}
		if (r === 'notifications') return browserNotify ? void (await Notification.requestPermission()) : undefined;
		if (!browserCamera) return;
		const stream = await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null);
		if (stream === null) return;
		proven.add('camera');
		stream.getTracks().forEach((t) => t.stop());
	}
	async function openSettings(r: DeviceRequirement): Promise<void> {
		const n = native(r);
		if (n !== undefined) return n.openSettings();
		if ((r === 'location' || r === 'location:background') && geo?.background !== undefined) return geo.background.openSettings();
	}
	return { check, request, openSettings };
}
