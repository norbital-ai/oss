// CSS/WAAPI exit-presence lifecycle (`create_presence`) and find-in-page panel revelation
// (`bind_findable` using `hidden="until-found"` and `beforematch`).
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';

/** Lifecycle phase of a presence-managed element. */
export type PresenceState = 'entering' | 'open' | 'exiting' | 'closed';

/** Options for `create_presence`. */
export type PresenceOptions = {
	/** Reactive open getter. */
	readonly open: () => boolean;
	/** Called once enter or exit settles. */
	readonly on_complete?: (open: boolean) => void;
};

/** Return value of `create_presence`. */
export type Presence = ReturnType<typeof create_presence>;

function parseTimeList(raw: string): number[] {
	return raw
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part !== '')
		.map((part) => {
			if (part.endsWith('ms')) return Number.parseFloat(part) || 0;
			if (part.endsWith('s')) return (Number.parseFloat(part) || 0) * 1000;
			return Number.parseFloat(part) || 0;
		});
}

function maxComputedDuration(el: HTMLElement): number {
	if (typeof getComputedStyle === 'undefined') return 0;
	const style = getComputedStyle(el);
	const animDurs = parseTimeList(style.animationDuration);
	const animDelays = parseTimeList(style.animationDelay);
	const transDurs = parseTimeList(style.transitionDuration);
	const transDelays = parseTimeList(style.transitionDelay);

	let max = 0;
	if (style.animationName !== 'none' && style.animationName !== '') {
		for (let i = 0; i < animDurs.length; i++) {
			const d = (animDurs[i] ?? 0) + (animDelays[i % Math.max(1, animDelays.length)] ?? 0);
			if (d > max) max = d;
		}
	}
	for (let i = 0; i < transDurs.length; i++) {
		const d = (transDurs[i] ?? 0) + (transDelays[i % Math.max(1, transDelays.length)] ?? 0);
		if (d > max) max = d;
	}
	return max;
}

function reducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

function waitAnimations(el: HTMLElement, onDone: () => void): () => void {
	if (reducedMotion()) {
		onDone();
		return () => {};
	}
	const running = typeof el.getAnimations === 'function' ? el.getAnimations() : [];
	const fallbackMs = maxComputedDuration(el);
	if (running.length === 0 && fallbackMs <= 0) {
		onDone();
		return () => {};
	}

	let finished = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finish = () => {
		if (finished) return;
		finished = true;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		onDone();
	};

	const timeoutMs = Math.max(fallbackMs, 50) + 50;
	timer = setTimeout(finish, timeoutMs);
	if (running.length > 0) {
		void Promise.allSettled(running.map((anim) => anim.finished)).then(finish);
	} else {
		const onEnd = (event: Event) => {
			if (event.target === el) finish();
		};
		el.addEventListener('animationend', onEnd, { once: true });
		el.addEventListener('transitionend', onEnd, { once: true });
		return () => {
			finished = true;
			if (timer !== undefined) clearTimeout(timer);
			el.removeEventListener('animationend', onEnd);
			el.removeEventListener('transitionend', onEnd);
		};
	}

	return () => {
		finished = true;
		if (timer !== undefined) clearTimeout(timer);
	};
}

/**
 * Keeps an element mounted while closing until its CSS/WAAPI exit animation finishes. Writes
 * `data-starting-style` on the first frame after mount and `data-ending-style` during exit.
 * In environments without animations (or under reduced motion), unmounts synchronously.
 */
export function create_presence(options: PresenceOptions) {
	let present = $state(untrack(() => options.open()));
	let phase = $state<PresenceState>(untrack(() => (options.open() ? 'open' : 'closed')));
	let node: HTMLElement | null = null;
	let cancelPending: (() => void) | null = null;

	function stopPending(): void {
		cancelPending?.();
		cancelPending = null;
	}

	$effect(() => {
		const open = options.open();
		stopPending();
		if (open) {
			present = true;
			phase = 'entering';
			if (node === null || reducedMotion()) {
				phase = 'open';
				options.on_complete?.(true);
				return;
			}
			const el = node;
			el.setAttribute('data-starting-style', '');
			el.removeAttribute('data-ending-style');
			let raf = 0;
			let done = false;
			if (typeof requestAnimationFrame === 'function') {
				raf = requestAnimationFrame(() => {
					raf = 0;
					if (done) return;
					el.removeAttribute('data-starting-style');
					phase = 'open';
					options.on_complete?.(true);
				});
			} else {
				el.removeAttribute('data-starting-style');
				phase = 'open';
				options.on_complete?.(true);
			}
			cancelPending = () => {
				done = true;
				if (raf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
				el.removeAttribute('data-starting-style');
			};
			return;
		}

		if (!present) {
			phase = 'closed';
			return;
		}

		if (node === null || reducedMotion()) {
			present = false;
			phase = 'closed';
			options.on_complete?.(false);
			return;
		}

		const el = node;
		phase = 'exiting';
		el.removeAttribute('data-starting-style');
		el.setAttribute('data-ending-style', '');
		cancelPending = waitAnimations(el, () => {
			el.removeAttribute('data-ending-style');
			if (!options.open()) {
				present = false;
				phase = 'closed';
				options.on_complete?.(false);
			}
		});
	});

	const attach: Attachment<HTMLElement> = (el) => {
		node = el;
		return () => {
			stopPending();
			if (node === el) node = null;
		};
	};

	return {
		get present() {
			return present;
		},
		get state(): PresenceState {
			return phase;
		},
		get exiting() {
			return phase === 'exiting';
		},
		attach
	};
}

/** Whether this browser supports find-in-page revelation via `hidden="until-found"` and `beforematch`. */
export function supports_hidden_until_found(): boolean {
	return typeof document !== 'undefined' && document.body !== null && 'onbeforematch' in document.body;
}

/** Options for `bind_findable`. */
export type FindableOptions = {
	/** Whether the panel is currently open/visible. */
	readonly open: () => boolean;
	/** Whether closed content remains findable via browser Ctrl/Cmd+F (default `true`). */
	readonly findable?: () => boolean;
	/** Called when browser find-in-page matches text inside the closed panel (`beforematch`). */
	readonly on_reveal: (event: Event) => void;
};

/**
 * Attachment keeping a closed panel discoverable by browser find-in-page (`hidden="until-found"`).
 * When the user searches text inside the closed panel, `on_reveal` fires so the panel opens cleanly.
 */
export function bind_findable(options: FindableOptions): Attachment<HTMLElement> {
	return (el) => {
		const sync = () => {
			if (options.open()) {
				el.removeAttribute('hidden');
				return;
			}
			const enabled = options.findable?.() ?? true;
			const desired = enabled ? 'until-found' : '';
			if (el.getAttribute('hidden') !== desired) {
				el.setAttribute('hidden', desired);
			}
		};

		const onBeforeMatch = (event: Event) => {
			options.on_reveal(event);
		};

		el.addEventListener('beforematch', onBeforeMatch);
		const mo =
			typeof MutationObserver === 'undefined'
				? null
				: new MutationObserver(() => {
						if (!options.open()) sync();
					});
		mo?.observe(el, { attributes: true, attributeFilter: ['hidden'] });

		$effect(() => {
			options.open();
			options.findable?.();
			sync();
		});

		return () => {
			mo?.disconnect();
			el.removeEventListener('beforematch', onBeforeMatch);
		};
	};
}
