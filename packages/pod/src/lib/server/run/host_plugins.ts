import type { HostAppPlugin } from '../../host/types.js';

/**
 * Host-owned sidebar surfaces, set once at startup.
 *
 * This is module state rather than request state on purpose. The set is a property of the deployment,
 * not of a caller, and reading it from a request header — the way the billing summary arrives — would
 * let anyone able to reach the pod put an arbitrary link under a host label into the sidebar. Under
 * Core the isolate boot frame sets it; under `pod start` the runner sets it from `pod.host.ts`.
 */
let plugins: readonly HostAppPlugin[] = [];

export function setHostPlugins(next: readonly HostAppPlugin[]): void {
	plugins = next;
}

export function getHostPlugins(): readonly HostAppPlugin[] {
	return plugins;
}
