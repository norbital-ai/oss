// Page views for the host (`ShellPorts.usage`): which page a person opened, from which, and how long that one stayed
// open. A view names a route pattern only; nothing here reads a record id, a query, a cookie or what was typed.
import type { PageView } from '@norbital-ai/host-api';
import { based, href, kiosk_href, SHELL, type Route } from './nav.ts';

const EVERY_MS = 10_000;
const MOST = 50;

/** A route's pattern: its page, never a record id or a query. */
export const route_pattern = (r: Route): string => {
	switch (r.kind) {
		case 'page':
			return href(r.app, r.page);
		case 'kiosk':
			return kiosk_href(r.kiosk, r.page);
		case 'home':
			return '/';
		case 'inbox':
			return '/inbox';
		case 'settings':
			return `/settings/${r.tab}`;
		case 'command_center':
			return `/command-center${r.tab === undefined ? '' : `/${r.tab}`}`;
		case 'studio':
			return `/studio${r.tab === undefined ? '' : `/${r.tab}`}`;
		case 'sign_in':
			return '/sign-in';
		case 'invite':
			return '/invite/:id';
		case 'not_found':
			return '/*';
	}
};

/**
 * Collects views and posts them to `/__bolt/shell/usage`: at most one batch every ten seconds and one as the page
 * hides, 50 views a batch (the rest are dropped). `view` names the page now open, which records the one it replaces
 * with how long it stayed; hiding the tab records the open page, and showing it again starts that page's time anew.
 */
export function page_views(f: typeof fetch = (input, init) => fetch(input, init)) {
	let open: { route: string; at: number } | null = null;
	let queue: PageView[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	const flush = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		if (queue.length === 0) return;
		const views = queue.slice(0, MOST);
		queue = [];
		// keepalive: the batch outlives a page that is closing; a lost batch is not retried
		void f(based(`${SHELL}/usage`), {
			method: 'POST',
			keepalive: true,
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ views })
		}).catch(() => undefined);
	};
	const left = () => {
		if (open === null) return;
		queue.push({ route: open.route, dwell_ms: Math.round(performance.now() - open.at) });
		timer ??= setTimeout(flush, EVERY_MS);
	};
	const visibility = () => {
		if (open === null) return;
		if (document.visibilityState === 'hidden') {
			left();
			flush();
		} else open = { route: open.route, at: performance.now() };
	};
	document.addEventListener('visibilitychange', visibility);
	return {
		view(route: string): void {
			if (open?.route === route) return;
			left();
			open = { route, at: performance.now() };
		},
		close(): void {
			document.removeEventListener('visibilitychange', visibility);
			left();
			flush();
		}
	};
}
