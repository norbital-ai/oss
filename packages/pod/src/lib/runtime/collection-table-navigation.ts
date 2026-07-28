import {
	resolveCollectionTableRecordId,
	type CollectionTableNavigation,
	type CollectionTableNavigationTarget
} from '@norbital-ai/ui/collection-table/navigation';
import type { NavStackItem } from '$lib/client/types.js';
import { DetailSurfaceService } from '$lib/client/subservices/detail_surface.service.js';
import { mergeCollectionDetailNavStack } from '$lib/client/utils/collection_detail_navigation.js';
import { getRouteContext } from '$lib/client/utils/route_context.js';

export function createPodCollectionTableNavigation(params: {
	getCurrentUrl: () => URL;
	getCurrentStack: () => NavStackItem[];
	navigation: DetailSurfaceService;
}): CollectionTableNavigation {
	const targetsFor = (target: CollectionTableNavigationTarget): NavStackItem[] => {
		const url = params.getCurrentUrl();
		const nextTarget: NavStackItem = {
			collection_name: target.collectionName,
			record_id: target.recordId,
			node_id: target.routeKey,
			viewMode: 'sidesheet'
		};
		return mergeCollectionDetailNavStack(
			params.getCurrentStack(),
			nextTarget,
			target.routeKey,
			getRouteContext(url),
			(stack, replacement) => params.navigation.replaceTargetByRouteKey(stack, replacement),
			target.parentRouteKey
		);
	};
	return {
		get current(): CollectionTableNavigationTarget | null {
			const stack = params.getCurrentStack();
			const current = stack.at(-1);
			if (!current) return null;
			return {
				collectionName: current.collection_name,
				recordId: current.record_id,
				routeKey: current.node_id,
				parentRouteKey: stack.at(-2)?.node_id
			};
		},
		resolveRecordId: (target) =>
			resolveCollectionTableRecordId(
				params.getCurrentStack().map((item, index, stack) => ({
					collectionName: item.collection_name,
					recordId: item.record_id,
					routeKey: item.node_id,
					parentRouteKey: stack[index - 1]?.node_id
				})),
				target
			),
		register: (registration) => params.navigation.register(registration),
		href: (target) =>
			params.navigation.generateUrlForTargets(params.getCurrentUrl(), targetsFor(target)),
		open: (target) => {
			const url = params.getCurrentUrl();
			params.navigation.navigateToTargets(url, targetsFor(target));
		},
		pop: () => params.navigation.pop(params.getCurrentUrl())
	};
}
