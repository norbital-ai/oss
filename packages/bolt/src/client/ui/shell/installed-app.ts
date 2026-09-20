import { PWA_MANIFEST_PATH, SERVICE_WORKER_PATH } from '@norbital-ai/bolt-protocol';

/**
 * Makes the document the workspace is mounted in installable, once per document.
 *
 * The runtime mints the manifest and worker under the request namespace of the host's mount, and
 * the mount is whatever precedes `/sync/stream` in the session — the one host-owned prefix the
 * client is already told. The manifest link carries `use-credentials` because a manifest is
 * otherwise fetched without cookies, and a host that routes the tenant by cookie would answer
 * the anonymous fetch with nothing. Pinch zoom is refused here too: `touch-action` handles it
 * everywhere but Safari-in-a-tab, which only listens to its own gesture event.
 */
export const installWorkspaceApp = (syncStreamUrl: string, title: string): void => {
	if (typeof document === 'undefined' || document.querySelector('link[rel="manifest"]') !== null)
		return;
	const streamPath = new URL(syncStreamUrl, 'http://bolt.invalid').pathname;
	const mount = streamPath.replace(/\/sync\/stream$/, '').replace(/\/+$/, '');
	// The human name travels with the bundle, not the runtime, so the document tells the runtime.
	const named = `?name=${encodeURIComponent(title)}`;
	const requests = `${mount}/request`;
	const link = document.createElement('link');
	link.rel = 'manifest';
	link.href = `${requests}${PWA_MANIFEST_PATH}${named}`;
	link.crossOrigin = 'use-credentials';
	document.head.append(link);
	document.addEventListener('gesturestart', (event) => event.preventDefault(), {
		passive: false
	});
	if (!('serviceWorker' in navigator)) return;
	void navigator.serviceWorker
		.register(`${requests}${SERVICE_WORKER_PATH}${named}`, { scope: `${mount}/` })
		.catch((cause: unknown) => console.warn('[bolt] service worker', cause));
};
