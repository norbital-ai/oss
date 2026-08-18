/**
 * Composer identity the shell header / FAB derive activity from.
 *
 * Written only from panel event handlers (send, pick thread, new conversation). The replica
 * query in the shell then turns that handle into idle / thinking / searching / authoring.
 */
const surface = $state({
	chatId: undefined as string | undefined,
	composingNew: false,
	pending: false,
	failed: false
});

export function getAgentSurface(): {
	readonly chatId: string | undefined;
	readonly composingNew: boolean;
	readonly pending: boolean;
	readonly failed: boolean;
} {
	return surface;
}

export function writeAgentSurface(next: {
	readonly chatId: string | undefined;
	readonly composingNew: boolean;
	readonly pending: boolean;
	readonly failed: boolean;
}): void {
	surface.chatId = next.chatId;
	surface.composingNew = next.composingNew;
	surface.pending = next.pending;
	surface.failed = next.failed;
}
