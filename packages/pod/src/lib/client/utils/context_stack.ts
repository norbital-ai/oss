import {
	NavStateSchema,
	type ContextNavStackItem,
	type NavStackItem,
	type NavState
} from '$lib/client/types.js';
import type { TFetchStackFrameInput } from '$lib/client/stack-frame.js';

/** Parses `?stack=` from a URL. App UI should read via {@link DetailSurfaceService.getCurrentNavStack}. */
export function parseNavStateFromUrl(url: URL): NavState | null {
	const raw = url.searchParams.get('stack');
	if (!raw) {
		return null;
	}

	try {
		const result = NavStateSchema.safeParse(JSON.parse(raw));
		if (!result.success) return null;
		return result.data;
	} catch {
		return null;
	}
}

function toContextNavStackItem(item: NavStackItem): ContextNavStackItem {
	return {
		collection_name: item.collection_name,
		record_id: item.record_id,
		node_id: item.node_id,
		with: item.with
	};
}

export function toContextNavStack(
	navState: NavState | null | undefined
): ContextNavStackItem[] | undefined {
	return navState?.stack.map(toContextNavStackItem);
}

export function parseFetchStackFrameInputFromUrl(url: URL): TFetchStackFrameInput | null {
	const navState = parseNavStateFromUrl(url);
	if (!navState) return null;

	return {
		stack: navState.stack.map(toContextNavStackItem)
	};
}
