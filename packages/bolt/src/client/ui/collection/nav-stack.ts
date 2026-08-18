import type { NavStackItem } from './detail-surface.js';

/**
 * How opening a record changes the detail stack.
 *
 * Appending is wrong once surfaces nest: opening the same nested surface twice pushed a duplicate
 * rather than replacing what was already there, so "back" had to be pressed once per visit and the
 * URL grew without bound. A surface identifies itself by route key, and reopening one replaces it
 * *within its parent's scope* — a sibling branch keeps its own entry.
 */

export type RouteContext = Readonly<{
	/** The app the stack belongs to, absent inside a host surface. */
	readonly app?: string;
	/** Host surfaces show one record at a time; they have no stack to nest into. */
	readonly hostSurface?: string;
}>;

/**
 * Reads the surface a URL is on. Colony serves apps at `/app/<name>` and host plugins at
 * `/__host/<plugin>`; anything else is neither and carries no context.
 */
export const routeContextOf = (url: URL): RouteContext | undefined => {
	const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
	const [first, ...rest] = segments;
	if (first === '__host' || first === 'host') {
		const plugin = rest[0];
		return plugin === undefined ? undefined : { hostSurface: decodeURIComponent(plugin) };
	}
	if (first === 'app' && rest.length > 0) {
		return { app: rest.map((segment) => decodeURIComponent(segment)).join('/') };
	}
	return undefined;
};

/** The path a stack's links are rooted at, so a generated URL stays on the surface it came from. */
export const baseUrlOf = (url: URL): string => {
	const context = routeContextOf(url);
	if (context?.hostSurface !== undefined)
		return `/__host/${encodeURIComponent(context.hostSurface)}`;
	if (context?.app !== undefined) {
		return `/app/${context.app
			.split('/')
			.map((segment) => encodeURIComponent(segment))
			.join('/')}`;
	}
	return url.pathname;
};

/**
 * Places `next` in the stack.
 *
 * - A host surface shows exactly one record, so the stack collapses to it.
 * - With a parent, the entry replaces any existing entry for the same route key *below that parent*,
 *   and otherwise truncates to the parent and appends — reopening a child never strands the entries
 *   that were under the previous one.
 * - Without a parent, the entry replaces any entry with the same route key, or appends.
 */
export const mergeDetailNavStack = (
	current: ReadonlyArray<NavStackItem>,
	next: NavStackItem,
	options: { readonly routeContext?: RouteContext; readonly parentRouteKey?: string } = {}
): ReadonlyArray<NavStackItem> => {
	if (options.routeContext?.hostSurface !== undefined) return [next];

	const routeKey = next.node_id;
	const parentRouteKey = options.parentRouteKey;
	if (parentRouteKey !== undefined) {
		const parentIndex = current.findIndex((item) => item.node_id === parentRouteKey);
		if (parentIndex !== -1) {
			const existing = current.findIndex(
				(item, index) => index > parentIndex && item.node_id === routeKey
			);
			return existing === -1
				? [...current.slice(0, parentIndex + 1), next]
				: [...current.slice(0, existing), next];
		}
	}
	const sameKey = current.findIndex((item) => item.node_id === routeKey);
	return sameKey === -1 ? [...current, next] : [...current.slice(0, sameKey), next];
};

/** Drops the deepest entry, which is what "back" means for a nested surface. */
export const popDetailNavStack = (
	current: ReadonlyArray<NavStackItem>
): ReadonlyArray<NavStackItem> => current.slice(0, -1);

/** The record a surface is currently showing, with the parent it was opened from. */
export const currentDetailTarget = (
	current: ReadonlyArray<NavStackItem>
): Readonly<{ item: NavStackItem; parentRouteKey?: string }> | undefined => {
	const item = current[current.length - 1];
	if (item === undefined) return undefined;
	const parent = current[current.length - 2];
	return parent === undefined ? { item } : { item, parentRouteKey: parent.node_id };
};
