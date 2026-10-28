// A typed segment commits when it is done, never per key: "0" of "03" is no write.
import './dom.ts';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it } from 'vitest';
import DateInput from '../src/kinds/date-input.svelte';

it('typing a day or month commits once, when the segment is done', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const changes: (string | null)[] = [];
	const view = mount(DateInput, {
		target,
		props: { value: '2026-09-27', onChange: (v: string | null) => changes.push(v) }
	});
	flushSync();
	const segment = (name: string) => {
		const found = target.querySelector<HTMLElement>(`[data-segment="${name}"]`);
		if (found === null) throw new Error(`no ${name} segment`);
		return found;
	};
	const key = (k: string) => {
		document.activeElement?.dispatchEvent(
			new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
		);
		flushSync();
	};
	segment('day').focus();
	key('0');
	expect(changes).toEqual([]);
	key('3');
	expect(changes).toEqual(['2026-09-03']);
	segment('month').focus();
	key('0');
	expect(changes).toEqual(['2026-09-03']);
	key('7');
	expect(changes).toEqual(['2026-09-03', '2026-07-03']);
	await unmount(view);
});
