import { flushSync, mount, unmount, type Component } from 'svelte';

/**
 * Mount a component into the document and hand back its root.
 *
 * Svelte 5 already exports everything a test needs to drive a component, so this is a shim over
 * `mount` and not a testing library: one more dependency here would only re-export `mount`,
 * `flushSync` and a `querySelector`.
 */
export function render<Props extends Record<string, unknown>>(
	component: Component<Props, Record<string, unknown>, string>,
	props: Props
): { readonly container: HTMLElement; destroy(): void } {
	const container = document.createElement('div');
	document.body.append(container);
	const instance = mount(component, { target: container, props });
	flushSync();
	return {
		container,
		destroy: () => {
			void unmount(instance);
			container.remove();
		}
	};
}

/**
 * Run out everything that is scheduled, including what the flush itself schedules.
 *
 * One turn is not enough and the difference matters: rendering a `$derived` can be what creates a
 * live query, whose first emission is then queued behind the assertion. A test that stops there is
 * really watching a first load arrive late, and would pass against a component that never listens
 * again — which is the failure this whole file exists to rule out. Draining to quiescence means a
 * row seen after a later write was delivered by that write.
 */
export async function settle(): Promise<void> {
	for (let turn = 0; turn < 3; turn += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

export function text(container: HTMLElement, selector: string): string[] {
	return [...container.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? '');
}
