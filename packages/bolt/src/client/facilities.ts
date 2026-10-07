/** A device permission as a host reports it; `prompt` means asking can still grant it. */
export type Access = 'granted' | 'prompt' | 'denied';
/** A native host's permission: its state, asking for it, and the phone's settings when it was refused. */
export type NativePermission = {
	status(): Promise<Access>;
	request(): Promise<Access>;
	openSettings(): Promise<void>;
};

/** Optional browser facilities supplied by the embedding host. Availability grants no server authority. */
export type ClientFacilities = {
	/** Native notifications (a host that raises in-app notices on the phone). */
	notifications?: NativePermission;
	/** Native camera permission, where the host's web view needs one. */
	camera?: NativePermission;
	geolocation?: {
		source: 'native' | 'browser';
		api: Geolocation;
		/** Native authorization, independently of whether a foreground fix is available. */
		background?: {
			status(): Promise<{ enabled: boolean; always: boolean }>;
			openSettings(): Promise<void>;
		};
	};
};

declare global {
	interface Window {
		boltHostFacilities?: ClientFacilities;
	}
}

/** Native facilities take precedence. Permission refusal must not switch to another provider. */
export function clientFacilities(host?: ClientFacilities): ClientFacilities {
	const injected = typeof window === 'undefined' ? undefined : window.boltHostFacilities;
	const supplied =
		host?.geolocation?.source === 'native'
			? host
			: injected?.geolocation?.source === 'native'
				? injected
				: (host ?? injected);
	const extra = {
		...(injected?.notifications === undefined ? {} : { notifications: injected.notifications }),
		...(injected?.camera === undefined ? {} : { camera: injected.camera }),
		...(host?.notifications === undefined ? {} : { notifications: host.notifications }),
		...(host?.camera === undefined ? {} : { camera: host.camera })
	};
	if (supplied?.geolocation !== undefined) return { geolocation: supplied.geolocation, ...extra };
	return typeof navigator !== 'undefined' && navigator.geolocation !== undefined
		? { geolocation: { source: 'browser', api: navigator.geolocation }, ...extra }
		: extra;
}
