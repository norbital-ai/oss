import type { CollectionTableDetailRegistration } from '@norbital-ai/ui/collection-table';

/** One frame in a nested detail nav stack (host system surfaces or sandbox page_record). */
export type DetailStackEntry = {
	routeKey: string;
	recordId: string;
	parentRouteKey?: string;
	collectionName?: string;
};

export type DetailSurfaceResolver = (
	routeKey: string,
	parentRouteKey?: string
) => CollectionTableDetailRegistration | undefined;
