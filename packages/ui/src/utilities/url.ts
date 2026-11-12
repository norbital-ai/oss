export const currentSearchParams = (): URLSearchParams =>
	typeof location === 'undefined' ? new URLSearchParams() : new URL(location.href).searchParams;

/** Keep the current path, fragment and history state while replacing viewer parameters. */
export function replaceSearchParams(params: URLSearchParams): void {
	if (typeof location === 'undefined') return;
	history.replaceState(history.state, '',
		`${location.pathname}${params.size > 0 ? `?${params}` : ''}${location.hash}`);
}
