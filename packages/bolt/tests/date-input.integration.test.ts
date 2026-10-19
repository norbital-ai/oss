// @vitest-environment happy-dom
// ui's DateInput commits a typed segment when it is done, never per key: "0" of "03" is no write, query or URL change.
import './setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it } from '@effect/vitest';
import DateInput from '../../ui/src/kinds/date-input.svelte';

it('typing a day commits once, when the segment is done', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const changes: (string | null)[] = [];
	const view = mount(DateInput, {
		target,
		props: { value: '2026-09-27', onChange: (v: string | null) => changes.push(v) }
	});
	try {
		flushSync();
		const day = () => {
			const segment = target.querySelector<HTMLElement>('[data-segment="day"]');
			if (segment === null) throw new Error('Date input did not render its day segment');
			return segment;
		};
		const key = (k: string) => {
			const active = document.activeElement;
			if (active === null) throw new Error('Date input has no focused segment');
			active.dispatchEvent(
				new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
			);
			flushSync();
		};
		day().focus();
		key('0');
		expect(changes).toEqual([]);
		key('3');
		expect(document.activeElement?.getAttribute('data-segment')).not.toBe('day');
		expect(changes).toEqual(['2026-09-03']);
		const month = target.querySelector<HTMLElement>('[data-segment="month"]');
		if (month === null) throw new Error('Date input did not render its month segment');
		month.focus();
		key('0');
		expect(changes).toEqual(['2026-09-03']);
		key('7');
		expect(changes).toEqual(['2026-09-03', '2026-07-03']);
	} finally {
		await unmount(view);
		target.remove();
	}
});
