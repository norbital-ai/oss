import { Effect } from 'effect';
import { toError } from '@norbital-ai/std';
import { tick } from 'svelte';

/** Shared duration for sliding selection indicators (tabs, file tree, sidebar rail). */
export const SLIDING_INDICATOR_MS = 200;

/** Sliding pill: position only — width/height snap so the pill glides A→B without fighting size changes. */
export const SLIDING_INDICATOR_TRANSITION_CLASS =
	'pointer-events-none absolute top-0 left-0 z-0 transition-transform duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] will-change-transform';

/** Folder expand/collapse in file tree — same duration and easing. */
export const SLIDING_INDICATOR_EXPAND_TRANSITION_CLASS =
	'grid min-h-0 transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]';

export type SlidingIndicatorRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export function rectFromOffsetElement(el: HTMLElement): SlidingIndicatorRect {
	const { offsetLeft: x, offsetTop: y, offsetWidth: width, offsetHeight: height } = el;
	return { x, y, width, height };
}

export function formatSlidingIndicatorStyle(
	rect: SlidingIndicatorRect,
	options: { useTransition: boolean; hasPositioned: boolean }
): string {
	const { x, y, width, height } = rect;
	const transition = options.hasPositioned && options.useTransition ? '' : ' transition: none;';
	return `transform: translate3d(${x}px, ${y}px, 0); width: ${width}px; height: ${height}px; opacity: 1;${transition}`;
}

export type SlidingIndicatorPositioned = { current: boolean };

/** Wiring a sliding indicator to a DOM measure: where the target lives and how its rect lands on a style string. */
type SlidingIndicatorMeasureConfig = {
	getTarget: () => HTMLElement | null;
	getRect?: (target: HTMLElement) => SlidingIndicatorRect | null;
	whenHidden?: () => boolean;
	onStyle: (style: string) => void;
	positioned: SlidingIndicatorPositioned;
	formatStyle?: (
		rect: SlidingIndicatorRect,
		options: { useTransition: boolean; hasPositioned: boolean }
	) => string;
};

export function bindSlidingIndicatorMeasure(
	config: SlidingIndicatorMeasureConfig
): (animate: boolean) => void {
	const formatStyle = config.formatStyle ?? formatSlidingIndicatorStyle;

	function measure(useTransition: boolean): void {
		if (config.whenHidden?.()) {
			config.onStyle('opacity: 0;');
			return;
		}
		const target = config.getTarget();
		if (!target || target.offsetWidth === 0) {
			config.onStyle('opacity: 0;');
			return;
		}
		const rect =
			config.getRect === undefined ? rectFromOffsetElement(target) : config.getRect(target);
		if (rect === null) {
			config.onStyle('opacity: 0;');
			return;
		}
		config.onStyle(
			formatStyle(rect, {
				useTransition,
				hasPositioned: config.positioned.current
			})
		);
		config.positioned.current = true;
	}

	return createSlidingIndicatorScheduler(measure);
}

export function observeSlidingIndicatorResize(
	root: HTMLElement,
	schedule: (animate: boolean) => void,
	selector = '[role="tab"]'
): () => void {
	const resizeObserver = new ResizeObserver(() => schedule(false));
	root.querySelectorAll(selector).forEach((el) => resizeObserver.observe(el));
	resizeObserver.observe(root);
	return () => resizeObserver.disconnect();
}

const ANIMATION_BUFFER_MS = 50;

/** Coalesce DOM measures; defer resize snaps while a slide is in flight. */
export function createSlidingIndicatorScheduler(
	measure: (useTransition: boolean) => void
): (animate: boolean) => void {
	let raf = 0;
	let animateNext = false;
	let isAnimating = false;
	let pendingResizeSync = false;
	let animateEndTimer: ReturnType<typeof setTimeout> | undefined;

	function clearAnimationTimer(): void {
		if (animateEndTimer !== undefined) {
			clearTimeout(animateEndTimer);
			animateEndTimer = undefined;
		}
	}

	function finishAnimation(): void {
		clearAnimationTimer();
		isAnimating = false;
		if (pendingResizeSync) {
			pendingResizeSync = false;
			enqueue(false);
		}
	}

	function beginAnimation(): void {
		clearAnimationTimer();
		isAnimating = true;
		animateEndTimer = setTimeout(finishAnimation, SLIDING_INDICATOR_MS + ANIMATION_BUFFER_MS);
	}

	function runMeasure(requestAnimate: boolean): void {
		if (requestAnimate) beginAnimation();
		measure(requestAnimate || isAnimating);
	}

	function enqueue(animate: boolean): void {
		animateNext = animateNext || animate;
		if (raf !== 0) return;

		const run = () => {
			raf = 0;
			const shouldAnimate = animateNext;
			animateNext = false;
			Effect.runFork(
				Effect.tryPromise({ try: tick, catch: toError }).pipe(
					Effect.map(() => runMeasure(shouldAnimate)),
					Effect.ignoreCause({
						log: true,
						message: '[SlidingIndicator] Failed to measure the indicator after rendering'
					})
				)
			);
		};

		if (animateNext) {
			raf = requestAnimationFrame(() => {
				raf = requestAnimationFrame(run);
			});
		} else {
			raf = requestAnimationFrame(run);
		}
	}

	return (animate: boolean) => {
		if (!animate && isAnimating) {
			pendingResizeSync = true;
			return;
		}
		enqueue(animate);
	};
}
