/** Report a normal workspace handoff without replacing its current screen or moving focus. */
export function beginWorkspaceNavigation(message: string): () => void {
	const cover = document.createElement('div');
	cover.className = 'workspace-opening access-loading-track';
	cover.setAttribute('role', 'status');
	cover.setAttribute('aria-live', 'polite');
	cover.setAttribute('aria-busy', 'true');
	const status = document.createElement('p');
	status.textContent = message;
	cover.append(status);
	document.body.append(cover);
	const navigation = window.navigation;
	let signal: AbortSignal | undefined;
	const stop = () => {
		cover.remove();
		window.removeEventListener('pagehide', stop);
		window.removeEventListener('pageshow', stop);
		window.removeEventListener('popstate', stop);
		window.removeEventListener('keydown', escape);
		window.removeEventListener('beforeunload', leaving);
		navigation?.removeEventListener('navigateerror', stop);
		navigation?.removeEventListener('navigate', navigating);
		signal?.removeEventListener('abort', stop);
	};
	const escape = (event: KeyboardEvent) => {
		if (event.key === 'Escape') stop();
	};
	const leaving = (event: BeforeUnloadEvent) => {
		// A refused unload leaves the current form usable, including browsers without Navigation API.
		queueMicrotask(() => {
			if (event.defaultPrevented) stop();
		});
	};
	const navigating = (event: Event) => {
		if ('signal' in event && event.signal instanceof AbortSignal) {
			signal?.removeEventListener('abort', stop);
			signal = event.signal;
			signal.addEventListener('abort', stop, { once: true });
		}
	};
	window.addEventListener('pagehide', stop);
	window.addEventListener('pageshow', stop);
	window.addEventListener('popstate', stop);
	window.addEventListener('keydown', escape);
	window.addEventListener('beforeunload', leaving);
	navigation?.addEventListener('navigateerror', stop);
	navigation?.addEventListener('navigate', navigating);
	return stop;
}

/** A normal link retains its browser navigation, modifiers and cancellation; only its waiting state changes. */
export function workspaceNavigation(node: HTMLAnchorElement, message: string) {
	let stop: (() => void) | undefined;
	const click = (event: MouseEvent) => {
		if (
			event.defaultPrevented ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey ||
			(node.target !== '' && node.target !== '_self') ||
			node.hasAttribute('download')
		)
			return;
		stop?.();
		const close = beginWorkspaceNavigation(message);
		stop = close;
		queueMicrotask(() => {
			if (event.defaultPrevented) close();
		});
	};
	node.addEventListener('click', click);
	return {
		update(next: string) {
			message = next;
		},
		destroy() {
			node.removeEventListener('click', click);
			stop?.();
		}
	};
}
