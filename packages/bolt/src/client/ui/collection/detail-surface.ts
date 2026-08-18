export type DetailViewMode = Readonly<'page' | 'modal' | 'sidesheet'>;
export type NavStackItem = Readonly<{
	readonly collection_name: string;
	readonly record_id: string;
	readonly node_id: string;
	readonly viewMode?: DetailViewMode;
	readonly with?: Readonly<Record<string, unknown>>;
}>;
export type DetailRegistration = Readonly<{
	readonly routeKey: string;
	readonly parentRouteKey?: string;
	readonly collection: string;
}>;
export type DetailSurfaceServiceOptions = Readonly<{
	readonly navigate?: (pathname: string) => void;
	readonly onRegistrationsChanged?: () => void;
}>;
const NavStack = Schema.Array(
	Schema.Struct({
		collection_name: Schema.NonEmptyString,
		record_id: Schema.NonEmptyString,
		node_id: Schema.NonEmptyString,
		viewMode: Schema.optionalKey(Schema.Literals(['page', 'modal', 'sidesheet'])),
		with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
	})
);

/** Owns detail surface service behavior at the collection boundary so validation and typed semantics stay consistent for every caller. */
export class DetailSurfaceService {
	readonly #registrations = new Map<string, DetailRegistration>();
	readonly #navigate: (pathname: string) => void;
	readonly #changed: () => void;
	/** Owns constructor behavior at the collection boundary so validation and typed semantics stay consistent for every caller. */
	constructor(options: DetailSurfaceServiceOptions = {}) {
		const navigate = options.navigate;
		const changed = options.onRegistrationsChanged;
		if (navigate !== undefined && typeof navigate !== 'function') {
			throw new TypeError('Detail navigation must be a function.');
		}
		if (changed !== undefined && typeof changed !== 'function') {
			throw new TypeError('Detail registration callback must be a function.');
		}
		this.#navigate = navigate ?? (() => undefined);
		this.#changed = changed ?? (() => undefined);
	}
	/** Owns <method> behavior at the collection boundary so validation and typed semantics stay consistent for every caller. */
	static readonly #key = (routeKey: string, parentRouteKey?: string): string =>
		`${parentRouteKey ?? ''}\u0000${routeKey}`;
	/** Owns register behavior at the collection boundary so validation and typed semantics stay consistent for every caller. */
	register(registration: DetailRegistration): () => void {
		const key = DetailSurfaceService.#key(registration.routeKey, registration.parentRouteKey);
		this.#registrations.set(key, registration);
		this.#changed();
		return () => {
			if (this.#registrations.get(key) !== registration) return;
			this.#registrations.delete(key);
			this.#changed();
		};
	}
	/** Owns resolve behavior at the collection boundary so validation and typed semantics stay consistent for every caller. */
	readonly resolve = (
		routeKey: string,
		parentRouteKey?: string
	): DetailRegistration | undefined => {
		return (
			this.#registrations.get(DetailSurfaceService.#key(routeKey, parentRouteKey)) ??
			this.#registrations.get(DetailSurfaceService.#key(routeKey))
		);
	};
	/** Owns read behavior at the collection boundary so validation and typed semantics stay consistent for every caller. */
	readonly read = (url: URL): ReadonlyArray<NavStackItem> => {
		const encoded = url.searchParams.get('stack');
		if (encoded === null) return [];
		try {
			return Schema.decodeUnknownSync(Schema.fromJsonString(NavStack))(encoded);
		} catch {
			return [];
		}
	};
	/** Owns url behavior at the collection boundary so validation and typed semantics stay consistent for every caller. */
	readonly url = (url: URL, stack: ReadonlyArray<NavStackItem>): string => {
		const next = new URL(url);
		if (stack.length === 0) next.searchParams.delete('stack');
		else next.searchParams.set('stack', JSON.stringify(stack));
		return `${next.pathname}${next.search}${next.hash}`;
	};
	/**
	 * Opens a record on this surface. Placement is `mergeDetailNavStack`'s decision, not an append:
	 * reopening a nested surface replaces its existing entry rather than stacking a duplicate.
	 */
	readonly open = (url: URL, item: NavStackItem, parentRouteKey?: string): void => {
		this.#navigate(
			this.url(
				url,
				mergeDetailNavStack(this.read(url), item, {
					...(routeContextOf(url) === undefined ? {} : { routeContext: routeContextOf(url) }),
					...(parentRouteKey === undefined ? {} : { parentRouteKey })
				})
			)
		);
	};
	/** Owns back behavior at the collection boundary so validation and typed semantics stay consistent for every caller. */
	readonly back = (url: URL): void => {
		this.#navigate(this.url(url, popDetailNavStack(this.read(url))));
	};
	/** The record this surface currently shows, and the parent it was opened from. */
	readonly current = (url: URL) => currentDetailTarget(this.read(url));
}
import { Schema } from 'effect';
import {
	currentDetailTarget,
	mergeDetailNavStack,
	popDetailNavStack,
	routeContextOf
} from './nav-stack.js';
