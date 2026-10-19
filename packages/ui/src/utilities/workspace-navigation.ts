/** Cover the current document while its normal workspace handoff is still waiting for a response. */
export function beginWorkspaceNavigation(message: string): () => void {
	const cover = document.createElement('div');
	cover.className = 'workspace-opening';
	cover.setAttribute('role', 'status');
	cover.setAttribute('aria-live', 'polite');
	cover.setAttribute('aria-busy', 'true');
	const content = document.createElement('div');
	const icon = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
	if (icon !== null) {
		const image = document.createElement('img');
		image.src = icon.href;
		image.alt = '';
		content.append(image);
	}
	const brand = document.createElement('strong');
	brand.textContent = 'Norbital';
	const status = document.createElement('p');
	status.textContent = message;
	const track = document.createElement('div');
	track.className = 'workspace-opening-track';
	track.setAttribute('aria-hidden', 'true');
	content.append(brand, status, track);
	cover.append(content);
	const focused = document.activeElement;
	cover.tabIndex = -1;
	document.body.append(cover);
	cover.focus({ preventScroll: true });
	const navigation = window.navigation;
	let signal: AbortSignal | undefined;
	const stop = () => {
		if (document.activeElement === cover && focused instanceof HTMLElement)
			focused.focus({ preventScroll: true });
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
