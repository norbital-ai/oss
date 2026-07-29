import { SvelteURL } from 'svelte/reactivity';

export interface PodPageState {
	readonly url: URL;
	readonly params: Readonly<Record<string, string>>;
}

const currentUrl = new SvelteURL(
	new URL(typeof window === 'undefined' ? 'http://pod.local/' : window.location.href)
);

if (typeof window !== 'undefined') {
	window.addEventListener('popstate', () => {
		currentUrl.href = window.location.href;
	});
}

export const page: PodPageState = {
	get url() {
		return currentUrl;
	},
	get params() {
		const match = currentUrl.pathname.match(/\/app\/(.+?)\/?$/);
		const params: Record<string, string> = {};
		if (match) {
			params.app = decodeURIComponent(match[1] ?? '');
			params.path = '';
		}
		return params;
	}
};

export async function goto(
	href: string | URL,
	options?: { readonly replaceState?: boolean }
): Promise<void> {
	if (typeof window === 'undefined') return;
	const target = new URL(href, window.location.href);
	if (options?.replaceState) window.history.replaceState({}, '', target);
	else window.history.pushState({}, '', target);
	currentUrl.href = target.href;
}
