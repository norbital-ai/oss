import './dom.ts';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import EventCalendar from '../src/event-calendar/event-calendar.svelte';

const at = new Date(2026, 10, 6, 9);
const events = [
	{ id: 'a', title: 'Present', start: at, end: new Date(2026, 10, 6, 17) },
	{ id: 'b', title: 'Public holiday', start: new Date(2026, 10, 9), end: new Date(2026, 10, 10) }
];
// happy-dom lays nothing out: a narrow calendar is told its width
const narrow = () => {
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
};

it('a narrow month lists the chosen day in full under its dots', () => {
	narrow();
	const onEventClick = vi.fn();
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(EventCalendar, {
		target,
		props: { events, view: 'month', date: at, onEventClick }
	});
	flushSync();
	expect(target.querySelector('[data-calendar-compact]')).not.toBeNull();
	const agenda = target.querySelector('[data-calendar-agenda]');
	expect(agenda?.textContent).toContain('Present');
	expect(agenda?.textContent).not.toContain('Public holiday');
	target.querySelector<HTMLButtonElement>('[data-calendar-compact] [data-day="9"]')?.click();
	flushSync();
	expect(target.querySelector('[data-calendar-agenda]')?.textContent).toContain('Public holiday');
	target.querySelector<HTMLButtonElement>('[data-calendar-agenda] [data-event="b"]')?.click();
	expect(onEventClick).toHaveBeenCalledWith(events[1]);
	unmount(view);
	target.remove();
	vi.restoreAllMocks();
});

it('a narrow week is a strip of days over one day', () => {
	narrow();
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(EventCalendar, { target, props: { events, view: 'week', date: at } });
	flushSync();
	const days = target.querySelectorAll<HTMLButtonElement>('[data-calendar-strip] button');
	expect(days).toHaveLength(7);
	expect(target.querySelector('[data-event="a"]')).not.toBeNull();
	days[1]?.click();
	flushSync();
	expect(target.querySelector('[data-event="a"]')).toBeNull();
	unmount(view);
	target.remove();
	vi.restoreAllMocks();
});
