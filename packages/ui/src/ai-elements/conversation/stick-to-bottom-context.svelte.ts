import { watch } from 'runed';
import { setContext, getContext } from 'svelte';

const STICK_TO_BOTTOM_CONTEXT_KEY = Symbol('stick-to-bottom-context');

type ScrollMetrics = Readonly<{
	scrollHeight: number;
	clientHeight: number;
}>;

/**
 * A shrinking transcript or a growing viewport can clamp `scrollTop` upward without user intent.
 * Preserve the bottom latch for that layout movement; wheel, key, touch, and pointer input still
 * win through `directManipulation`.
 */
export function shouldPreserveBottomLatchAfterUpwardScroll(
	previous: ScrollMetrics,
	current: ScrollMetrics,
	options: Readonly<{ stuck: boolean; directManipulation: boolean }>
): boolean {
	return (
		options.stuck &&
		!options.directManipulation &&
		(current.scrollHeight < previous.scrollHeight - 0.5 ||
			current.clientHeight > previous.clientHeight + 0.5)
	);
}

/**
 * Stick-to-bottom for streaming chat.
 *
 * User latch:
 * - Any upward scroll / wheel-up → unlock (cancel pending pins)
 * - Reach the bottom again (or scrollToBottom) → latch
 *
 * While latched: content ResizeObserver pins scrollTop at most once per frame.
 * Pins use a synchronous flag (not a time window) so user scroll-up is never swallowed.
 */
class StickToBottomContext {
	#element: HTMLElement | null = $state(null);
	#stuck = $state(true);
	#LATCH_BOTTOM_PX = 40;
	#lastScrollTop = 0;
	#lastScrollHeight = 0;
	#lastClientHeight = 0;
	#directManipulation = false;
	/** True only while we assign scrollTop — never a timed window. */
	#isPinning = false;
	#raf = 0;
	#contentResizeObserver: ResizeObserver | null = null;
	#rootResizeObserver: ResizeObserver | null = null;

	isAtBottom = $derived(this.#stuck);

	constructor() {
		watch(
			() => this.#element,
			() => {
				if (this.#element) {
					this.#setupObservers();
					return () => this.#cleanup();
				}
			}
		);
	}

	setElement(element: HTMLElement) {
		this.#element = element;
	}

	/** Explicit latch + jump (scroll button / initial mount). */
	scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
		if (!this.#element) return;
		this.#stuck = true;
		if (behavior === 'smooth') {
			this.#isPinning = true;
			this.#element.scrollTo({
				top: this.#element.scrollHeight,
				behavior: 'smooth'
			});
			// Smooth animation emits many scroll events; clear pinning when it settles near bottom.
			const start = performance.now();
			const settle = () => {
				if (!this.#element) {
					this.#isPinning = false;
					return;
				}
				if (this.#isAtBottom() || performance.now() - start > 500) {
					this.#isPinning = false;
					this.#lastScrollTop = this.#element.scrollTop;
					return;
				}
				requestAnimationFrame(settle);
			};
			requestAnimationFrame(settle);
		} else {
			this.#pinNow();
		}
	};

	#distanceFromBottom(): number {
		if (!this.#element) return 0;
		const { scrollTop, scrollHeight, clientHeight } = this.#element;
		return scrollHeight - scrollTop - clientHeight;
	}

	#isAtBottom(): boolean {
		return this.#distanceFromBottom() <= this.#LATCH_BOTTOM_PX;
	}

	#unlock() {
		this.#stuck = false;
		this.#isPinning = false;
		if (this.#raf) {
			cancelAnimationFrame(this.#raf);
			this.#raf = 0;
		}
	}

	#pinNow() {
		if (!this.#element || !this.#stuck) return;
		const top = Math.max(0, this.#element.scrollHeight - this.#element.clientHeight);
		if (Math.abs(this.#element.scrollTop - top) < 1) {
			this.#lastScrollTop = this.#element.scrollTop;
			return;
		}
		this.#isPinning = true;
		this.#element.scrollTop = top;
		this.#lastScrollTop = top;
		// Clear after the scroll event from this assignment has been delivered.
		requestAnimationFrame(() => {
			this.#isPinning = false;
			if (this.#element) this.#lastScrollTop = this.#element.scrollTop;
		});
	}

	#schedulePin() {
		if (!this.#stuck || this.#raf) return;
		// Already glued — skip forced layout work this frame.
		if (this.#distanceFromBottom() <= 1) return;
		this.#raf = requestAnimationFrame(() => {
			this.#raf = 0;
			this.#pinNow();
		});
	}

	#handleScroll = () => {
		if (!this.#element) return;
		const { scrollTop, scrollHeight, clientHeight } = this.#element;
		const previousMetrics = {
			scrollHeight: this.#lastScrollHeight,
			clientHeight: this.#lastClientHeight
		};
		this.#lastScrollHeight = scrollHeight;
		this.#lastClientHeight = clientHeight;

		if (this.#isPinning) {
			this.#lastScrollTop = scrollTop;
			return;
		}

		const scrolledUp = scrollTop < this.#lastScrollTop - 0.5;
		this.#lastScrollTop = scrollTop;

		if (scrolledUp) {
			if (
				shouldPreserveBottomLatchAfterUpwardScroll(
					previousMetrics,
					{ scrollHeight, clientHeight },
					{ stuck: this.#stuck, directManipulation: this.#directManipulation }
				)
			) {
				this.#schedulePin();
				return;
			}
			this.#unlock();
			return;
		}

		if (this.#isAtBottom()) {
			this.#stuck = true;
		}
	};

	#handleWheel = (event: WheelEvent) => {
		if (event.deltaY < 0) {
			this.#unlock();
		}
	};

	#handleTouchStart = () => {
		this.#directManipulation = true;
		// Let subsequent scroll events decide; don't treat touch as pin.
		this.#isPinning = false;
	};

	#handleTouchEnd = () => {
		this.#directManipulation = false;
	};

	#handlePointerDown = () => {
		this.#directManipulation = true;
	};

	#handlePointerUp = () => {
		this.#directManipulation = false;
	};

	#handleKeyDown = (event: KeyboardEvent) => {
		if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) this.#unlock();
	};

	#observeContent(content: HTMLElement) {
		this.#contentResizeObserver?.disconnect();
		this.#contentResizeObserver = new ResizeObserver(() => {
			if (this.#stuck) this.#schedulePin();
		});
		this.#contentResizeObserver.observe(content);
	}

	#setupObservers() {
		if (!this.#element) return;

		this.#lastScrollTop = this.#element.scrollTop;
		this.#lastScrollHeight = this.#element.scrollHeight;
		this.#lastClientHeight = this.#element.clientHeight;

		this.#element.addEventListener('scroll', this.#handleScroll, { passive: true });
		this.#element.addEventListener('wheel', this.#handleWheel, { passive: true });
		this.#element.addEventListener('touchstart', this.#handleTouchStart, { passive: true });
		this.#element.addEventListener('touchend', this.#handleTouchEnd, { passive: true });
		this.#element.addEventListener('pointerdown', this.#handlePointerDown, { passive: true });
		this.#element.addEventListener('pointerup', this.#handlePointerUp, { passive: true });
		this.#element.addEventListener('pointercancel', this.#handlePointerUp, { passive: true });
		this.#element.addEventListener('keydown', this.#handleKeyDown);

		const content = this.#element.querySelector(
			'[data-stick-to-bottom-content]'
		) as HTMLElement | null;
		if (content) {
			// Prefer content observer only — root + content both firing duplicates pins.
			this.#observeContent(content);
		} else {
			this.#rootResizeObserver = new ResizeObserver(() => {
				if (this.#stuck) this.#schedulePin();
			});
			this.#rootResizeObserver.observe(this.#element);
		}

		if (this.#stuck) this.#schedulePin();
	}

	#cleanup() {
		if (this.#raf) {
			cancelAnimationFrame(this.#raf);
			this.#raf = 0;
		}
		this.#contentResizeObserver?.disconnect();
		this.#rootResizeObserver?.disconnect();

		if (this.#element) {
			this.#element.removeEventListener('scroll', this.#handleScroll);
			this.#element.removeEventListener('wheel', this.#handleWheel);
			this.#element.removeEventListener('touchstart', this.#handleTouchStart);
			this.#element.removeEventListener('touchend', this.#handleTouchEnd);
			this.#element.removeEventListener('pointerdown', this.#handlePointerDown);
			this.#element.removeEventListener('pointerup', this.#handlePointerUp);
			this.#element.removeEventListener('pointercancel', this.#handlePointerUp);
			this.#element.removeEventListener('keydown', this.#handleKeyDown);
		}

		this.#directManipulation = false;
		this.#contentResizeObserver = null;
		this.#rootResizeObserver = null;
	}
}

export function setStickToBottomContext(): StickToBottomContext {
	const context = new StickToBottomContext();
	setContext(STICK_TO_BOTTOM_CONTEXT_KEY, context);
	return context;
}

export function getStickToBottomContext(): StickToBottomContext {
	const context = getContext<StickToBottomContext>(STICK_TO_BOTTOM_CONTEXT_KEY);
	if (!context) {
		throw new Error('StickToBottomContext must be used within a Conversation component');
	}
	return context;
}

export { StickToBottomContext };
