import './dom.ts';
import { it, vi } from '@effect/vitest';
import { browser, required } from './view-fixture.ts';
import { element } from './elements.ts';
import assert from 'node:assert/strict';
import { contentMotion } from '../src/form/content-motion.ts';

// happy-dom has no Web Animations implementation; unsupported fixture members fail explicitly.
class MotionAnimation extends EventTarget implements Animation {
	readonly #completion = Promise.withResolvers<Animation>();
	readonly finished = this.#completion.promise;
	cancel() {
		this.#completion.reject(new DOMException('Animation cancelled', 'AbortError'));
	}
	finish() {
		this.#completion.resolve(this);
	}
	get currentTime(): Animation['currentTime'] {
		return this.unsupported('currentTime');
	}
	get effect(): Animation['effect'] {
		return this.unsupported('effect');
	}
	get id(): Animation['id'] {
		return this.unsupported('id');
	}
	get oncancel(): Animation['oncancel'] {
		return this.unsupported('oncancel');
	}
	get onfinish(): Animation['onfinish'] {
		return this.unsupported('onfinish');
	}
	get onremove(): Animation['onremove'] {
		return this.unsupported('onremove');
	}
	get overallProgress(): Animation['overallProgress'] {
		return this.unsupported('overallProgress');
	}
	get pending(): Animation['pending'] {
		return this.unsupported('pending');
	}
	get playState(): Animation['playState'] {
		return this.unsupported('playState');
	}
	get playbackRate(): Animation['playbackRate'] {
		return this.unsupported('playbackRate');
	}
	get ready(): Animation['ready'] {
		return this.unsupported('ready');
	}
	get replaceState(): Animation['replaceState'] {
		return this.unsupported('replaceState');
	}
	get startTime(): Animation['startTime'] {
		return this.unsupported('startTime');
	}
	get timeline(): Animation['timeline'] {
		return this.unsupported('timeline');
	}
	commitStyles() {
		this.unsupported('commitStyles');
	}
	pause() {
		this.unsupported('pause');
	}
	persist() {
		this.unsupported('persist');
	}
	play() {
		this.unsupported('play');
	}
	reverse() {
		this.unsupported('reverse');
	}
	updatePlaybackRate(_rate: number) {
		this.unsupported('updatePlaybackRate');
	}
	override addEventListener<K extends keyof AnimationEventMap>(
		type: K,
		listener: (this: Animation, event: AnimationEventMap[K]) => unknown,
		options?: boolean | AddEventListenerOptions
	): void;
	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions
	): void;
	override addEventListener(
		_type: string,
		_listener:
			| EventListenerOrEventListenerObject
			| ((this: Animation, event: AnimationPlaybackEvent) => unknown)
			| null,
		_options?: boolean | AddEventListenerOptions
	): void {
		this.unsupported('addEventListener');
	}
	override removeEventListener<K extends keyof AnimationEventMap>(
		type: K,
		listener: (this: Animation, event: AnimationEventMap[K]) => unknown,
		options?: boolean | EventListenerOptions
	): void;
	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions
	): void;
	override removeEventListener(
		_type: string,
		_listener:
			| EventListenerOrEventListenerObject
			| ((this: Animation, event: AnimationPlaybackEvent) => unknown)
			| null,
		_options?: boolean | EventListenerOptions
	): void {
		this.unsupported('removeEventListener');
	}
	private unsupported(member: string): never {
		throw new Error(`MotionAnimation fixture does not implement ${member}`);
	}
}

for (const reduced of [false, true])
	it.live(`record changes respect reduced motion: ${reduced}`, () =>
		browser(async () => {
			const media = window.matchMedia('(prefers-reduced-motion: reduce)');
			const matches = vi.spyOn(media, 'matches', 'get').mockReturnValue(reduced);
			const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue(media);
			const target = document.createElement('div');
			target.innerHTML = '<div><dl><div><dt>Terms</dt><dd>Net 30</dd></div></dl></div>';
			document.body.append(target);
			let played = 0;
			const animation = new MotionAnimation();
			const cancelled = vi.spyOn(animation, 'cancel');
			const field = element<HTMLElement>(target, 'dd');
			field.animate = (_frames, options) => {
				assert.ok(typeof options === 'object' && options !== null);
				assert.equal(options.duration, 700);
				played++;
				return animation;
			};
			const action = contentMotion(target);
			try {
				required(field.firstChild).textContent = 'Net 60';
				await new Promise((resolve) => setTimeout(resolve, 10));
				assert.equal(played, reduced ? 0 : 1);
			} finally {
				action.destroy();
				target.remove();
				matchMedia.mockRestore();
				matches.mockRestore();
			}
			assert.equal(cancelled.mock.calls.length, reduced ? 0 : 1);
		})
	);

it.live('new version fields animate even when the section is replaced', () =>
	browser(async () => {
		const target = document.createElement('article');
		target.dataset.view = 'record';
		document.body.append(target);
		const action = contentMotion(target);
		const section = document.createElement('section');
		section.innerHTML = '<dl><dd>Net 60</dd></dl>';
		let played = 0;
		element<HTMLElement>(section, 'dd').animate = () => {
			played++;
			const animation = new MotionAnimation();
			animation.finish();
			return animation;
		};
		try {
			target.append(section);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(played, 1);
		} finally {
			action.destroy();
			target.remove();
		}
	})
);

it.live('section height follows replacement content inside a record shell', () =>
	browser(async () => {
		const original = globalThis.ResizeObserver;
		const observed: Element[] = [],
			removed: Element[] = [];
		let observer: MotionResizeObserver | undefined;
		class MotionResizeObserver implements ResizeObserver {
			readonly #targets = new Set<Element>();
			readonly callback: ResizeObserverCallback;
			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
				observer = this;
			}
			observe(node: Element, _options?: ResizeObserverOptions) {
				this.#targets.add(node);
				observed.push(node);
			}
			unobserve(node: Element) {
				this.#targets.delete(node);
				removed.push(node);
			}
			disconnect() {
				this.#targets.clear();
			}
			deliver(target: Element, contentRect: DOMRectReadOnly) {
				assert.ok(this.#targets.has(target));
				const border = target.getBoundingClientRect();
				const entry: ResizeObserverEntry = {
					target,
					contentRect,
					contentBoxSize: [{ blockSize: contentRect.height, inlineSize: contentRect.width }],
					borderBoxSize: [{ blockSize: border.height, inlineSize: border.width }],
					devicePixelContentBoxSize: [
						{
							blockSize: contentRect.height * window.devicePixelRatio,
							inlineSize: contentRect.width * window.devicePixelRatio
						}
					]
				};
				this.callback([entry], this);
			}
		}
		globalThis.ResizeObserver = MotionResizeObserver;
		const article = document.createElement('article');
		article.dataset.view = 'record';
		const section = document.createElement('section');
		section.dataset.section = 'contract';
		const body = document.createElement('div');
		body.id = 'contract-body';
		const before = document.createElement('div');
		const bounds = before.getBoundingClientRect();
		const beforeBounds = vi
			.spyOn(before, 'getBoundingClientRect')
			.mockReturnValue(new DOMRect(bounds.x, bounds.y, bounds.width, 20));
		body.append(before);
		section.append(body);
		article.append(section);
		document.body.append(article);
		const frames: Keyframe[][] = [];
		body.animate = (value) => {
			assert.ok(Array.isArray(value));
			frames.push(value);
			const animation = new MotionAnimation();
			animation.finish();
			return animation;
		};
		const action = contentMotion(body);
		try {
			const after = document.createElement('div');
			body.replaceChildren(after);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.deepEqual(removed, [before]);
			assert.deepEqual(observed, [before, after]);
			const rectangle = after.getBoundingClientRect();
			const resized = new DOMRect(rectangle.x, rectangle.y, rectangle.width, 50);
			const afterBounds = vi.spyOn(after, 'getBoundingClientRect').mockReturnValue(resized);
			try {
				required(observer).deliver(after, resized);
				assert.equal(required(required(frames[0])[0]).height, '20px');
				assert.equal(required(required(frames[0])[1]).height, '50px');
			} finally {
				afterBounds.mockRestore();
			}
		} finally {
			action.destroy();
			article.remove();
			beforeBounds.mockRestore();
			globalThis.ResizeObserver = original;
		}
	})
);
