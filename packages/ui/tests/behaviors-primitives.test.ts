import './dom.ts';
import { flushSync, mount, tick, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import BehaviorsPrimitivesHarness from './behaviors-primitives-harness.svelte';

function must<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined) throw new Error(`Expected ${label}`);
	return value;
}

it('exercises watch, Debounced, use_debounce, PersistedState, floating, portal, pin, date/time fields and single/range calendar', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	try {
		window.localStorage.removeItem('nb:test:pref');
		const watchLog: string[] = [];
		const pinCompleted: string[] = [];
		const debouncedCalls: string[] = [];
		const floatDismissals: string[] = [];

		const portalHost = document.body.appendChild(document.createElement('div'));
		const target = document.body.appendChild(document.createElement('div'));
		const view = mount(BehaviorsPrimitivesHarness, {
			target,
			props: {
				portal_host: portalHost,
				on_watch_log: (entry) => watchLog.push(entry),
				on_pin_complete: (code) => pinCompleted.push(code),
				on_debounced_call: (v) => debouncedCalls.push(v),
				on_float_dismiss: (r) => floatDismissals.push(r)
			}
		});
		await tick();

		// 1. Reactive utilities: eager watch + once watch.pre ran once; lazy tuple watch skipped initial run
		expect(watchLog).toContain('eager:1:none');
		expect(watchLog).toContain('pre:1');
		expect(watchLog.some((e) => e.startsWith('tuple:'))).toBe(false);

		must(target.querySelector<HTMLButtonElement>('[data-testid="inc-count"]'), 'inc-count').click();
		flushSync();
		expect(watchLog).toContain('eager:2:1');
		expect(watchLog).toContain('tuple:2/a:1/a');
		// `once: true` pre-watcher did not fire a second time
		expect(watchLog.filter((e) => e.startsWith('pre:')).length).toBe(1);

		must(target.querySelector<HTMLButtonElement>('[data-testid="flip-tag"]'), 'flip-tag').click();
		flushSync();
		expect(watchLog).toContain('tuple:2/b:2/a');

		// Debounced & use_debounce settle after wait window
		const callDeb = must(
			target.querySelector<HTMLButtonElement>('[data-testid="call-debounce"]'),
			'call-debounce'
		);
		callDeb.click();
		callDeb.click();
		expect(debouncedCalls).toEqual([]);
		await vi.advanceTimersByTimeAsync(50);
		await tick();
		expect(debouncedCalls).toEqual(['v-2']);
		expect(must(target.querySelector('[data-testid="debounced-val"]'), 'debounced-val').textContent).toBe('2');

		// PersistedState writes to localStorage
		const persistBtn = must(
			target.querySelector<HTMLButtonElement>('[data-testid="toggle-persist"]'),
			'toggle-persist'
		);
		expect(must(target.querySelector('[data-testid="persisted-val"]'), 'persisted-val').textContent).toBe('light');
		persistBtn.click();
		flushSync();
		expect(must(target.querySelector('[data-testid="persisted-val"]'), 'persisted-val').textContent).toBe('dark');
		expect(window.localStorage.getItem('nb:test:pref')).toBe('"dark"');

		// 2. Floating: opens anchored, flips to top when anchor is near viewport bottom, dismisses on Escape
		const anchor = must(
			target.querySelector<HTMLButtonElement>('[data-testid="float-anchor"]'),
			'float-anchor'
		);
		anchor.getBoundingClientRect = () => new DOMRect(40, 740, 100, 32);
		anchor.click();
		flushSync();
		const floatEl = must(target.querySelector<HTMLElement>('[data-testid="float-content"]'), 'float-content');
		floatEl.getBoundingClientRect = () => new DOMRect(0, 0, 180, 120);
		window.dispatchEvent(new Event('resize'));
		await vi.advanceTimersByTimeAsync(25);
		flushSync();
		expect(floatEl.style.position).toBe('fixed');
		expect(floatEl.getAttribute('data-side')).toBe('top');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		flushSync();
		expect(floatDismissals).toEqual(['escape']);
		expect(target.querySelector('[data-testid="float-content"]')).toBeNull();

		// 3. Portal + PortalConfig: mounts into configured portal_host, moves back in-place when disabled
		const portaled = must(portalHost.querySelector('[data-testid="portaled-box"]'), 'portaled-box in host');
		expect(portaled.textContent?.trim()).toBe('portaled text');
		expect(target.querySelector('[data-testid="portal-origin"] [data-testid="portaled-box"]')).toBeNull();
		must(
			target.querySelector<HTMLButtonElement>('[data-testid="toggle-portal-disabled"]'),
			'toggle-portal-disabled'
		).click();
		flushSync();
		expect(target.querySelector('[data-testid="portal-origin"] [data-testid="portaled-box"]')).not.toBeNull();

		// 4. Pin input: typing fills cells and fires on_complete at max_length
		const pinInput = must(target.querySelector<HTMLInputElement>('[data-testid="pin-input"]'), 'pin-input');
		pinInput.value = '4821';
		pinInput.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(must(target.querySelector('[data-testid="pin-wrap"]'), 'pin-wrap').getAttribute('data-pin-value')).toBe('4821');
		expect(pinCompleted).toEqual(['4821']);
		expect(must(target.querySelector('[data-pin-cell="3"]'), 'cell 3').textContent?.trim()).toBe('1');

		// 5. Date field: ArrowUp cycles day, multi-digit typing "05" buffers leading 0 without premature commit
		const dateWrap = must(target.querySelector('[data-testid="date-field"]'), 'date-field');
		const daySeg = must(dateWrap.querySelector<HTMLElement>('[data-segment="day"]'), 'day seg');
		daySeg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
		flushSync();
		expect(dateWrap.getAttribute('data-date-value')).toBe('2026-03-16');

		const monthSeg = must(dateWrap.querySelector<HTMLElement>('[data-segment="month"]'), 'month seg');
		monthSeg.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true }));
		flushSync();
		// Leading "0" is buffered, date not yet mutated to month 01
		expect(dateWrap.getAttribute('data-date-value')).toBe('2026-03-16');
		monthSeg.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true, cancelable: true }));
		flushSync();
		expect(dateWrap.getAttribute('data-date-value')).toBe('2026-05-16');

		// Backspace clears date value
		daySeg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
		flushSync();
		expect(dateWrap.getAttribute('data-date-value')).toBe('');

		// 6. Time field: ArrowUp cycles hour, numeric entry updates minute
		const timeWrap = must(target.querySelector('[data-testid="time-field"]'), 'time-field');
		const hourSeg = must(timeWrap.querySelector<HTMLElement>('[data-segment="hour"]'), 'hour seg');
		hourSeg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
		flushSync();
		expect(timeWrap.getAttribute('data-time-value')).toBe('10:30:00');
		const minSeg = must(timeWrap.querySelector<HTMLElement>('[data-segment="minute"]'), 'minute seg');
		minSeg.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true, cancelable: true }));
		minSeg.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true, cancelable: true }));
		flushSync();
		expect(timeWrap.getAttribute('data-time-value')).toBe('10:45:00');

		// 7. Single calendar: month nav & day selection
		const singleWrap = must(target.querySelector('[data-testid="single-cal"]'), 'single-cal');
		expect(singleWrap.getAttribute('data-month')).toBe('2026-04-01');
		must(target.querySelector<HTMLButtonElement>('[data-testid="single-next"]'), 'single-next').click();
		flushSync();
		expect(singleWrap.getAttribute('data-month')).toBe('2026-05-01');
		must(singleWrap.querySelector<HTMLButtonElement>('[data-single-day="2026-05-12"]'), '2026-05-12').click();
		flushSync();
		expect(singleWrap.getAttribute('data-selected')).toBe('2026-05-12');

		// 8. Range calendar: 2 months rendered, reverse click order normalizes start <= end
		const rangeWrap = must(target.querySelector('[data-testid="range-cal"]'), 'range-cal');
		expect(rangeWrap.getAttribute('data-months')).toBe('2');
		must(rangeWrap.querySelector<HTMLButtonElement>('[data-range-day="2026-05-20"]'), '2026-05-20').click();
		flushSync();
		expect(rangeWrap.getAttribute('data-start')).toBe('2026-05-20');
		expect(rangeWrap.getAttribute('data-end')).toBe('');
		must(rangeWrap.querySelector<HTMLButtonElement>('[data-range-day="2026-05-10"]'), '2026-05-10').click();
		flushSync();
		expect(rangeWrap.getAttribute('data-start')).toBe('2026-05-10');
		expect(rangeWrap.getAttribute('data-end')).toBe('2026-05-20');
		expect(
			must(rangeWrap.querySelector('[data-range-day="2026-05-15"]'), '2026-05-15').hasAttribute('data-selected')
		).toBe(true);

		unmount(view);
		target.remove();
		portalHost.remove();
		window.localStorage.removeItem('nb:test:pref');
	} finally {
		vi.useRealTimers();
	}
});
