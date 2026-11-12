// Served unchanged at the workspace's service-worker URL; push runs without a page or a live inbox connection.
export const PUSH_WORKER = `self.addEventListener('install', (e) => {
	e.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (e) => {
	e.waitUntil(self.clients.claim());
});
self.addEventListener('push', (e) => {
	const n = e.data ? e.data.json() : {};
	const scope = new URL(self.registration.scope);
	e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
		const foreground = windows.some((w) => {
			const url = new URL(w.url);
			return w.focused && w.visibilityState === 'visible' && url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
		});
		if (!foreground) return self.registration.showNotification(n.title || '', {
			tag: n.id,
			body: n.body || undefined,
			data: { url: new URL((n.path || '/inbox').replace(/^[/]/, ''), scope).href }
		});
	}));
});
self.addEventListener('notificationclick', (e) => {
	e.notification.close();
	e.waitUntil(self.clients.openWindow(e.notification.data.url));
});
`;
