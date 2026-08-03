import type { NavStackItem, ViewMode } from '$lib/ui/state/types.js';
import type { TRouteContext } from '$lib/ui/collection/utils/route_context.js';

type ExpandSpec = Record<string, unknown>;

export function buildCollectionDetailNavTarget(params: {
	routeContext: TRouteContext | null;
	collectionName: string;
	recordId: string;
	routeKey: string;
	viewMode?: ViewMode;
	expand?: ExpandSpec;
}): NavStackItem {
	const viewMode = params.viewMode ?? 'sidesheet';

	return {
		collection_name: params.collectionName,
		record_id: params.recordId,
		node_id: params.routeKey,
		viewMode,
		with: params.expand ? { ...params.expand } : undefined
	};
}

export function mergeCollectionDetailNavStack(
	currentStack: readonly NavStackItem[],
	nextTarget: NavStackItem,
	routeKey: string,
	routeContext: TRouteContext | null,
	replaceTargetByRouteKey: (
		currentStack: NavStackItem[],
		params: { routeKey: string; nextTarget: NavStackItem }
	) => NavStackItem[],
	parentRouteKey?: string
): NavStackItem[] {
	if (routeContext?.isWorkspaceStudio) {
		return [nextTarget];
	}

	if (parentRouteKey) {
		const parentIndex = currentStack.findIndex((item) => item.node_id === parentRouteKey);
		if (parentIndex !== -1) {
			const matchIndex = currentStack.findIndex(
				(item, index) => index > parentIndex && item.node_id === routeKey
			);
			if (matchIndex !== -1) {
				return [...currentStack.slice(0, matchIndex), nextTarget];
			}
			return [...currentStack.slice(0, parentIndex + 1), nextTarget];
		}
	}

	return replaceTargetByRouteKey([...currentStack], {
		routeKey,
		nextTarget
	});
}
