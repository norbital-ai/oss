// Composable clipboard behavior with async Clipboard API + legacy textarea fallback and
// auto-resetting `copied` state. Used directly by `CopyText` and exported for tenant copy buttons.
import { onDestroy } from 'svelte';

/** Options for `create_clipboard`. */
export type ClipboardOptions = {
	/** Text to copy (reactive getter or static string). */
	text: string | (() => string);
	/** How long `copied` stays `true` in ms (default `1500`). */
	timeout_ms?: number;
	/** Optional callback after a copy attempt completes. */
	on_copy?: (ok: boolean, value: string) => void;
};

/** Return value of `create_clipboard`. */
export type Clipboard = ReturnType<typeof create_clipboard>;

function legacyCopy(value: string): boolean {
	if (typeof document === 'undefined') return false;
	const area = document.createElement('textarea');
	area.value = value;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.inset = '0 auto auto -9999px';
	document.body.appendChild(area);
	area.select();
	try {
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		area.remove();
	}
}

/**
 * Headless clipboard copy behavior with transient `copied` indicator and embedded-frame fallback.
 */
export function create_clipboard(options: ClipboardOptions) {
	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	onDestroy(() => {
		disposed = true;
		if (timer !== undefined) clearTimeout(timer);
	});

	async function copy(override?: string): Promise<boolean> {
		const value = override ?? (typeof options.text === 'function' ? options.text() : options.text);
		let ok = false;
		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(value);
				ok = true;
			} else {
				ok = legacyCopy(value);
			}
		} catch {
			ok = legacyCopy(value);
		}
		if (disposed) return ok;
		if (timer !== undefined) clearTimeout(timer);
		copied = ok;
		timer = undefined;
		if (ok) {
			timer = setTimeout(() => {
				copied = false;
				timer = undefined;
			}, options.timeout_ms ?? 1500);
		}
		options.on_copy?.(ok, value);
		return ok;
	}

	return {
		get copied() {
			return copied;
		},
		copy,
		reset() {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			copied = false;
		}
	};
}
