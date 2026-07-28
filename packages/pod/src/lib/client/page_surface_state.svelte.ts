import { goto, navigating, page } from './router.svelte.js';
import {
	PlatformState,
	setPlatformStateContext,
	type PlatformStateParams
} from '$lib/client/platform_state.svelte.js';
import {
	DetailSurfaceService,
	type DetailSurfaceServiceOptions
} from '$lib/client/subservices/detail_surface.service.js';
import type { TDynamicApplicationScopeData } from '$lib/client/types.js';
import { createContext } from 'svelte';

const [getPageSurfaceContext, setPageSurfaceContext] = createContext<() => PageSurfaceState>();

export function getPageSurfaceStateContext(): () => PageSurfaceState {
	return getPageSurfaceContext();
}

export function setPageSurfaceStateContext(context: () => PageSurfaceState): void {
	setPageSurfaceContext(context);
	setPlatformStateContext(context);
}

export type PageSurfaceStateParams = PlatformStateParams & {
	detailSurfaceOptions?: Omit<DetailSurfaceServiceOptions, 'navigateInternal'>;
};

/** Page navigation, detail stack, and scope hydration on top of {@link PlatformState}. */
export class PageSurfaceState extends PlatformState {
	readonly navigation: DetailSurfaceService;
	detailSurfaceRegistrationRevision = $state(0);
	currentUrl = $derived(page.url);

	protected getScopeDataForDerivation(): TDynamicApplicationScopeData | null {
		return null;
	}

	scopeData = $derived.by(() => this.getScopeDataForDerivation());

	state = $derived.by(() => {
		const currentUrl = this.currentUrl;
		const navState = this.navigation.getCurrentNavStack(currentUrl);
		return {
			currentUrl,
			isNavigating: Boolean(navigating.to),
			navState,
			navStack: navState ? this.navigation.toNavigationTargets(navState.stack) : []
		};
	});

	constructor(params: PageSurfaceStateParams) {
		super(params);
		this.navigation = new DetailSurfaceService({
			...params.detailSurfaceOptions,
			onRegistrationsChanged: () => {
				this.detailSurfaceRegistrationRevision += 1;
				params.detailSurfaceOptions?.onRegistrationsChanged?.();
			},
			navigateInternal: (pathname) => {
				const href = pathname.startsWith('/') ? pathname : `/${pathname}`;
				void goto(href);
			}
		});
	}
}
