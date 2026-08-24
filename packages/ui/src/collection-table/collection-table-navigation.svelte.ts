import { safeParse } from '@norbital-ai/std';
import type { CollectionClient, ErasedCollectionRegistry } from '@norbital-ai/std/collection';
import { getContext, setContext } from 'svelte';
import { Schema } from 'effect';

const collectionTableNavigationTargetSchema = Schema.Struct({
	collectionName: Schema.String,
	recordId: Schema.String,
	routeKey: Schema.String,
	parentRouteKey: Schema.optionalKey(Schema.String)
});
export type CollectionTableNavigationTarget = typeof collectionTableNavigationTargetSchema.Type;

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
	registerDetailClient(
		routeKey: string,
		client: CollectionClient<ErasedCollectionRegistry>
	): () => void;
	registerCollectionClient(
		collectionName: string,
		client: () => CollectionClient<ErasedCollectionRegistry>
	): () => void;
	detailClient(
		routeKey: string,
		collectionName?: string
	): CollectionClient<ErasedCollectionRegistry> | undefined;
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

/** A registry keyed by name, whose entries carry the token that may release them. */
type ClientRegistry<TClient> = Map<string, Readonly<{ token: symbol; client: TClient }>>;

/**
 * Hold `client` under `key` and hand back the release for it.
 *
 * The token is what makes the release safe to call late: a registration that has already been
 * replaced by a newer one for the same key leaves the newer entry alone.
 */
function registerClient<TClient>(
	registry: ClientRegistry<TClient>,
	key: string,
	client: TClient
): () => void {
	const token = Symbol(key);
	registry.set(key, { token, client });
	return () => {
		if (registry.get(key)?.token === token) registry.delete(key);
	};
}

export class CollectionTableUrlNavigation implements CollectionTableNavigation {
	readonly #getUrl: () => URL;
	readonly #navigate: (href: string) => void;
	readonly #detailClients: ClientRegistry<CollectionClient<ErasedCollectionRegistry>> = new Map();
	readonly #collectionClients: ClientRegistry<() => CollectionClient<ErasedCollectionRegistry>> =
		new Map();

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

	/**
	 * Makes a table's own client available to the sibling detail frame that its URL opens.
	 *
	 * Most tables use the workspace client already published above the navigation surface. Host
	 * projections such as People are deliberately different: their rows live in a read-only local
	 * client and have no tenant collection to dispatch. The route key identifies the table that
	 * opened the frame, so the sheet can read through that exact capability without teaching the
	 * runtime about a host-only pseudo-collection.
	 */
	registerDetailClient(
		routeKey: string,
		client: CollectionClient<ErasedCollectionRegistry>
	): () => void {
		return registerClient(this.#detailClients, routeKey, client);
	}

	/**
	 * Registers one explicitly named host projection independently of any mounted table.
	 *
	 * This is deliberately collection-by-collection rather than registering every definition on a
	 * client: People may own its three host-only projections, but cannot accidentally capture an
	 * unrelated tenant collection with the same navigation surface.
	 */
	registerCollectionClient(
		collectionName: string,
		client: () => CollectionClient<ErasedCollectionRegistry>
	): () => void {
		return registerClient(this.#collectionClients, collectionName, client);
	}

	detailClient(
		routeKey: string,
		collectionName?: string
	): CollectionClient<ErasedCollectionRegistry> | undefined {
		const collectionClient =
			collectionName === undefined
				? undefined
				: this.#collectionClients.get(collectionName)?.client();
		return collectionClient ?? this.#detailClients.get(routeKey)?.client;
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
