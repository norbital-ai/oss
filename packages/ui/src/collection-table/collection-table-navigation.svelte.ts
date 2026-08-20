import { safeParse } from '@norbital-ai/std';
import { getContext, setContext } from 'svelte';
import { Schema } from 'effect';

export interface CollectionTableNavigationTarget {
	collectionName: string;
	recordId: string;
	routeKey: string;
	parentRouteKey?: string;
}

export interface CollectionTableNavigation {
	readonly current: CollectionTableNavigationTarget | null;
	resolveRecordId(params: {
		collectionName: string;
		routeKey: string;
		parentRouteKey?: string;
	}): string | undefined;
	href(target: CollectionTableNavigationTarget): string;
	open(target: CollectionTableNavigationTarget): void;
	pop(): void;
}

const urlNavigationStackItemSchema = Schema.Struct({
	collection_name: Schema.String,
	record_id: Schema.String,
	node_id: Schema.String,
	viewMode: Schema.Literals(['page', 'sidesheet'])
});
type UrlNavigationStackItem = typeof urlNavigationStackItemSchema.Type;

const decodeUrlNavigationStack = Schema.decodeUnknownResult(
	Schema.Struct({ stack: Schema.Array(urlNavigationStackItemSchema) })
);

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

export function createCollectionTableRouteKey(params: { view: string }): string {
	return `collection-table:${params.view}`;
}

function parseUrlNavigationStack(url: URL): UrlNavigationStackItem[] {
	const value = url.searchParams.get('stack');
	if (!value) return [];
	const result = decodeUrlNavigationStack(safeParse(value));
	return result._tag === 'Success' ? [...result.success.stack] : [];
}

export class CollectionTableUrlNavigation implements CollectionTableNavigation {
	readonly #getUrl: () => URL;
	readonly #navigate: (href: string) => void;

	constructor(params: { getUrl: () => URL; navigate: (href: string) => void }) {
		this.#getUrl = params.getUrl;
		this.#navigate = params.navigate;
	}

	get current(): CollectionTableNavigationTarget | null {
		return this.#targets().at(-1) ?? null;
	}

	/**
	 * Every frame of the URL stack, shallowest first.
	 *
	 * A detail registration only exists while the table that owns it is mounted, and a nested
	 * table is mounted by its parent frame's detail surface. Rendering only the deepest frame
	 * therefore unmounts the very table the deepest frame needs, so the surface renders the
	 * whole chain and keeps each ancestor alive.
	 */
	get targets(): CollectionTableNavigationTarget[] {
		return this.#targets();
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

	/** Close the frame at `depth`, keeping every shallower frame open. */
	popTo(depth: number): void {
		const url = this.#getUrl();
		const stack = parseUrlNavigationStack(url);
		this.#navigate(this.#hrefForStack(url, stack.slice(0, Math.max(0, depth))));
	}

	pop(): void {
		this.popTo(parseUrlNavigationStack(this.#getUrl()).length - 1);
	}

	#hrefForStack(url: URL, stack: UrlNavigationStackItem[]): string {
		const next = new URL(url);
		if (stack.length === 0) next.searchParams.delete('stack');
		else next.searchParams.set('stack', JSON.stringify({ stack }));
		return `${next.pathname}${next.search}${next.hash}`;
	}
}
