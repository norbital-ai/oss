/** Optional browser facilities supplied by the embedding host. Availability grants no server authority. */
export type ClientFacilities = {
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
	if (supplied?.geolocation !== undefined) return { geolocation: supplied.geolocation };
	return typeof navigator !== 'undefined' && navigator.geolocation !== undefined
		? { geolocation: { source: 'browser', api: navigator.geolocation } }
		: {};
}
