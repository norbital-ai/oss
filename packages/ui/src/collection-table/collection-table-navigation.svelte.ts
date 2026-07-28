import { safeParse } from '@norbital-ai/std';
import { getContext, setContext, type Snippet } from 'svelte';
import { z } from 'zod';

export interface CollectionTableNavigationTarget {
	collectionName: string;
	recordId: string;
	routeKey: string;
	parentRouteKey?: string;
}

export interface CollectionTableDetailRenderContext {
	recordId: string;
	actions?: Snippet;
}

export interface CollectionTableDetailRegistration {
	routeKey: string;
	parentRouteKey?: string;
	renderDetail: Snippet<[CollectionTableDetailRenderContext]>;
}

export interface CollectionTableNavigation {
	readonly current: CollectionTableNavigationTarget | null;
	resolveRecordId(params: {
		collectionName: string;
		routeKey: string;
		parentRouteKey?: string;
	}): string | undefined;
	register(registration: CollectionTableDetailRegistration): () => void;
	href(target: CollectionTableNavigationTarget): string;
	open(target: CollectionTableNavigationTarget): void;
	pop(): void;
}

interface UrlNavigationStackItem {
	collection_name: string;
	record_id: string;
	node_id: string;
	viewMode: 'page' | 'sidesheet';
}

const urlNavigationStackItemSchema: z.ZodType<UrlNavigationStackItem> = z.object({
	collection_name: z.string(),
	record_id: z.string(),
	node_id: z.string(),
	viewMode: z.enum(['page', 'sidesheet'])
});

const urlNavigationStackSchema = z.object({
	stack: z.array(urlNavigationStackItemSchema)
});

const COLLECTION_TABLE_NAVIGATION_CONTEXT = Symbol.for(
	'@norbital-ai/ui/collection-table-navigation'
);

export function setCollectionTableNavigationContext(
	navigation: CollectionTableNavigation
): CollectionTableNavigation {
	setContext(COLLECTION_TABLE_NAVIGATION_CONTEXT, navigation);
	return navigation;
}

export function getCollectionTableNavigationContext(): CollectionTableNavigation | undefined {
	return getContext<CollectionTableNavigation>(COLLECTION_TABLE_NAVIGATION_CONTEXT);
}

export function resolveCollectionTableRecordId(
	targets:
		CollectionTableNavigationTarget | readonly CollectionTableNavigationTarget[] | null | undefined,
	params: { collectionName: string; routeKey: string; parentRouteKey?: string }
): string | undefined {
	const stack = targets == null ? [] : Array.isArray(targets) ? targets : [targets];
	for (let index = stack.length - 1; index >= 0; index -= 1) {
		const target = stack[index];
		if (
			target.collectionName === params.collectionName &&
			target.routeKey === params.routeKey &&
			(params.parentRouteKey === undefined || target.parentRouteKey === params.parentRouteKey)
		) {
			return target.recordId;
		}
	}
	return undefined;
}

export function createCollectionTableRouteKey(params: {
	view: string;
}): string {
	return `collection-table:${params.view}`;
}

function parseUrlNavigationStack(url: URL): UrlNavigationStackItem[] {
	const value = url.searchParams.get('stack');
	if (!value) return [];
	const result = urlNavigationStackSchema.safeParse(safeParse(value));
	return result.success ? result.data.stack : [];
}

function registrationKey(routeKey: string, parentRouteKey?: string): string {
	return `${parentRouteKey ?? ''}\u0000${routeKey}`;
}

export class CollectionTableUrlNavigation implements CollectionTableNavigation {
	readonly #getUrl: () => URL;
	readonly #navigate: (href: string) => void;
	readonly #onRegistrationsChanged: () => void;
	readonly #registrations = new Map<string, CollectionTableDetailRegistration>();

	constructor(params: {
		getUrl: () => URL;
		navigate: (href: string) => void;
		onRegistrationsChanged?: () => void;
	}) {
		this.#getUrl = params.getUrl;
		this.#navigate = params.navigate;
		this.#onRegistrationsChanged = params.onRegistrationsChanged ?? (() => undefined);
	}

	get current(): CollectionTableNavigationTarget | null {
		return this.#targets().at(-1) ?? null;
	}

	resolveRecordId(params: {
		collectionName: string;
		routeKey: string;
		parentRouteKey?: string;
	}): string | undefined {
		return resolveCollectionTableRecordId(this.#targets(), params);
	}

	#targets(): CollectionTableNavigationTarget[] {
		const stack = parseUrlNavigationStack(this.#getUrl());
		return stack.map((item, index) => ({
			collectionName: item.collection_name,
			recordId: item.record_id,
			routeKey: item.node_id,
			parentRouteKey: stack[index - 1]?.node_id
		}));
	}

	register(registration: CollectionTableDetailRegistration): () => void {
		const key = registrationKey(registration.routeKey, registration.parentRouteKey);
		this.#registrations.set(key, registration);
		this.#onRegistrationsChanged();
		return () => {
			if (this.#registrations.get(key) !== registration) return;
			this.#registrations.delete(key);
			this.#onRegistrationsChanged();
		};
	}

	resolveCurrentRegistration(): CollectionTableDetailRegistration | undefined {
		const current = this.current;
		if (!current) return undefined;
		return (
			this.#registrations.get(registrationKey(current.routeKey, current.parentRouteKey)) ??
			this.#registrations.get(registrationKey(current.routeKey))
		);
	}

	href(target: CollectionTableNavigationTarget): string {
		const url = this.#getUrl();
		const stack = parseUrlNavigationStack(url);
		const nextItem: UrlNavigationStackItem = {
			collection_name: target.collectionName,
			record_id: target.recordId,
			node_id: target.routeKey,
			viewMode: 'sidesheet'
		};
		const parentIndex = target.parentRouteKey
			? stack.findIndex((item) => item.node_id === target.parentRouteKey)
			: -1;
		const matchIndex = stack.findIndex(
			(item, index) =>
				item.node_id === target.routeKey && (parentIndex === -1 || index > parentIndex)
		);
		const nextStack =
			matchIndex !== -1
				? [...stack.slice(0, matchIndex), nextItem]
				: parentIndex !== -1
					? [...stack.slice(0, parentIndex + 1), nextItem]
					: [...stack, nextItem];
		return this.#hrefForStack(url, nextStack);
	}

	open(target: CollectionTableNavigationTarget): void {
		this.#navigate(this.href(target));
	}

	pop(): void {
		const url = this.#getUrl();
		const stack = parseUrlNavigationStack(url);
		this.#navigate(this.#hrefForStack(url, stack.slice(0, -1)));
	}

	#hrefForStack(url: URL, stack: UrlNavigationStackItem[]): string {
		const next = new URL(url);
		if (stack.length === 0) next.searchParams.delete('stack');
		else next.searchParams.set('stack', JSON.stringify({ stack }));
		return `${next.pathname}${next.search}${next.hash}`;
	}
}
