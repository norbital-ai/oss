import type { CollectionTableDetailRegistration } from '@norbital-ai/ui/collection-table/navigation';
import { SvelteMap } from 'svelte/reactivity';
import {
	NavStateSchema,
	isSameNavStackItem,
	type NavStackItem,
	type NavState,
	type ViewMode
} from '$lib/client/types.js';
import { parseNavStateFromUrl } from '$lib/client/utils/context_stack.js';
import {
	getBaseUrlForRouteContext,
	getRouteContext,
	type TRouteContext
} from '$lib/client/utils/route_context.js';

export type DetailSurfaceServiceOptions = {
	navigateInternal?: (pathname: string) => void;
	onRegistrationsChanged?: () => void;
	routeContext?: {
		getRouteContext: (url: URL) => TRouteContext | null;
		getBaseUrlForRouteContext: (url: URL) => string;
	};
};

export class DetailSurfaceService {
	readonly #registrations = new SvelteMap<string, CollectionTableDetailRegistration>();
	readonly #navigateInternal: (pathname: string) => void;
	readonly #onRegistrationsChanged: () => void;
	readonly #getRouteContext: (url: URL) => TRouteContext | null;
	readonly #getBaseUrlForRouteContext: (url: URL) => string;

	constructor(options?: DetailSurfaceServiceOptions) {
		this.#navigateInternal = options?.navigateInternal ?? (() => undefined);
		this.#onRegistrationsChanged = options?.onRegistrationsChanged ?? (() => undefined);
		this.#getRouteContext = options?.routeContext?.getRouteContext ?? getRouteContext;
		this.#getBaseUrlForRouteContext =
			options?.routeContext?.getBaseUrlForRouteContext ?? getBaseUrlForRouteContext;
	}

	static #registryKey(parentRouteKey: string | undefined, routeKey: string): string {
		return `${parentRouteKey ?? ''}\u0000${routeKey}`;
	}

	register(input: CollectionTableDetailRegistration): () => void {
		const key = DetailSurfaceService.#registryKey(input.parentRouteKey, input.routeKey);
		this.#registrations.set(key, input);
		this.#onRegistrationsChanged();

		return () => {
			if (this.#registrations.get(key) !== input) {
				return;
			}
			this.#registrations.delete(key);
			this.#onRegistrationsChanged();
		};
	}

	resolve(
		routeKey: string,
		parentRouteKey?: string
	): CollectionTableDetailRegistration | undefined {
		const exact = this.#registrations.get(
			DetailSurfaceService.#registryKey(parentRouteKey, routeKey)
		);
		if (exact || parentRouteKey === undefined) {
			return exact;
		}
		return this.#registrations.get(DetailSurfaceService.#registryKey(undefined, routeKey));
	}

	/** Reads `?stack=`; writes go through {@link navigateToTargets}, {@link applyNavState}, or {@link urlForNavState}. */
	getCurrentNavStack(url: URL): NavState | null {
		return parseNavStateFromUrl(url);
	}

	getCurrentSelection(url: URL): NavStackItem | null {
		return this.getCurrentNavStack(url)?.stack.at(-1) ?? null;
	}

	toNavigationTargets(stack: NavStackItem[]): NavStackItem[] {
		return stack.map((item) => ({
			collection_name: item.collection_name,
			record_id: item.record_id,
			node_id: item.node_id,
			viewMode: item.viewMode,
			with: item.with
		}));
	}

	generateUrlForTargets(url: URL, targets: NavStackItem[]): string {
		if (targets.length === 0) {
			const nextUrl = new URL(url);
			nextUrl.searchParams.delete('stack');
			nextUrl.pathname = this.#getBaseUrlForRouteContext(url);
			nextUrl.searchParams.delete('from');
			return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
		}

		let nextState: NavState | null = null;
		for (const target of targets) {
			const stackItem = this.#toNavStackItem(target);
			nextState = this.#mutateNavState(nextState, stackItem);
		}

		if (nextState === null) {
			throw new Error('Navigation targets did not produce a nav state.');
		}

		return this.#generateUrl(url, nextState);
	}

	navigateToTargets(url: URL, targets: NavStackItem[]): void {
		this.#navigateInternal(this.generateUrlForTargets(url, targets));
	}

	replaceTargetByRouteKey(
		currentStack: NavStackItem[],
		params: { routeKey: string; nextTarget: NavStackItem }
	): NavStackItem[] {
		const matchIndex = currentStack.findIndex((item) =>
			this.#sharesRouteKey(item, params.routeKey)
		);
		if (matchIndex === -1) {
			return [...currentStack, params.nextTarget];
		}
		return [...currentStack.slice(0, matchIndex), params.nextTarget];
	}

	generateNextUrl(url: URL, stackItem: NavStackItem): string {
		const current = this.getCurrentNavStack(url);
		return this.#generateUrl(url, this.#mutateNavState(current, stackItem));
	}

	generateUrlAtIndex(url: URL, index: number): string {
		if (!Number.isInteger(index)) {
			throw new Error('Index must be an integer.');
		}

		if (index === -1) {
			const nextUrl = new URL(url);
			nextUrl.searchParams.delete('stack');
			nextUrl.pathname = this.#getBaseUrlForRouteContext(url);
			nextUrl.searchParams.delete('from');
			return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
		}

		const navState = this.getCurrentNavStack(url);
		if (!navState) {
			throw new Error('No stack to index into.');
		}
		if (index < 0 || index >= navState.stack.length) {
			throw new Error(
				`Index out of range for nav stack. Valid range: 0..${Math.max(0, navState.stack.length - 1)}.`
			);
		}

		return this.#generateUrl(url, {
			...navState,
			stack: navState.stack.slice(0, index + 1)
		});
	}

	generatePreviousUrl(url: URL): string {
		const navState = this.getCurrentNavStack(url);
		if (!navState || navState.stack.length <= 1) {
			const fallbackUrl = new URL(url);
			fallbackUrl.searchParams.delete('stack');
			fallbackUrl.pathname = this.#getBaseUrlForRouteContext(url);
			fallbackUrl.searchParams.delete('from');
			return `${fallbackUrl.pathname}${fallbackUrl.search}${fallbackUrl.hash}`;
		}

		return this.generateUrlAtIndex(url, navState.stack.length - 2);
	}

	pop(url: URL): void {
		this.#navigateInternal(this.generatePreviousUrl(url));
	}

	applyNavState(url: URL, next: NavState): void {
		const validatedNext = NavStateSchema.safeParse(next);
		if (!validatedNext.success) return;
		this.#navigateInternal(this.#generateUrl(url, validatedNext.data));
	}

	/** Canonical `?stack=` URL for a validated nav state (e.g. task detail hrefs). */
	urlForNavState(url: URL, next: NavState): string {
		const validatedNext = NavStateSchema.safeParse(next);
		if (!validatedNext.success) {
			throw new Error('Invalid nav state');
		}
		return this.#generateUrl(url, validatedNext.data);
	}

	#mutateNavState(current: NavState | null, stackItem: NavStackItem): NavState {
		const currentStack = current?.stack ?? [];
		const existingItemIndex = currentStack.findIndex((item) => isSameNavStackItem(item, stackItem));
		if (existingItemIndex !== -1) {
			return { stack: currentStack.slice(0, existingItemIndex + 1) };
		}
		return { stack: [...currentStack, stackItem] };
	}

	#generateUrl(url: URL, navState: NavState): string {
		const validated = NavStateSchema.parse(navState);
		const nextUrl = new URL(url);
		const routeContext = this.#getRouteContext(url);
		const organization =
			routeContext?.organization ?? url.pathname.split('/').filter(Boolean).at(0);

		if (organization) {
			nextUrl.pathname = this.#getBaseUrlForRouteContext(url);
			nextUrl.searchParams.delete('from');
		}

		nextUrl.searchParams.set('stack', JSON.stringify(validated));
		return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
	}

	#toNavStackItem(target: NavStackItem): NavStackItem {
		if (!target.node_id.trim()) {
			throw new Error('Navigation stack items require node_id.');
		}
		return {
			collection_name: target.collection_name,
			record_id: target.record_id,
			node_id: target.node_id,
			viewMode: target.viewMode ?? 'sidesheet',
			with: target.with
		};
	}

	#sharesRouteKey(item: NavStackItem, routeKey: string): boolean {
		return item.node_id === routeKey;
	}
}
