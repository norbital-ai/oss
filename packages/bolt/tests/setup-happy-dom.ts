// Use the SDK's shared storage shim and offline icon cache before shell components load.
import '../src/test/dom.ts';
import { icons as vscodeIcons } from '@iconify-json/vscode-icons/index.js';
import { addCollection } from '@iconify/svelte/dist/functions';

// Studio's source tree uses this icon family in addition to the shared Lucide cache.
addCollection(vscodeIcons);

if (!('ResizeObserver' in globalThis)) {
	globalThis.ResizeObserver = class implements ResizeObserver {
		constructor(_callback: ResizeObserverCallback) {}
		observe(_target: Element, _options?: ResizeObserverOptions): void {}
		unobserve(_target: Element): void {}
		disconnect(): void {}
	};
}

if (!document.fonts) {
	Object.defineProperty(document, 'fonts', {
		value: { ready: Promise.resolve() },
		configurable: true
	});
}
