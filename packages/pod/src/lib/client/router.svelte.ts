export interface PodPageState {
	readonly url: URL;
	readonly params: Readonly<Record<string, string>>;
}

let currentUrl = $state(
	new URL(typeof window === 'undefined' ? 'http://pod.local/' : window.location.href)
);
let navigationTarget = $state<URL>();

if (typeof window !== 'undefined') {
	window.addEventListener('popstate', () => {
		currentUrl = new URL(window.location.href);
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

export const navigating = {
	get to(): URL | undefined {
		return navigationTarget;
	}
};

export async function goto(
	href: string | URL,
	options?: { readonly replaceState?: boolean }
): Promise<void> {
	if (typeof window === 'undefined') return;
	const target = new URL(href, window.location.href);
	navigationTarget = target;
	if (options?.replaceState) window.history.replaceState({}, '', target);
	else window.history.pushState({}, '', target);
	currentUrl = target;
	navigationTarget = undefined;
}
