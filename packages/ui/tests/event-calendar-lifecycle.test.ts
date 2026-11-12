import './dom.ts';
import { expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import EventCalendar from '../src/event-calendar/event-calendar.svelte';
import Harness from './event-calendar-harness.svelte';
import { lanes, type CalendarEvent } from '../src/event-calendar/calendar.ts';

const date = new Date(2026, 10, 6, 15, 30);
const grid_of = (target: HTMLElement) => {
	const grid = target.querySelector<HTMLElement>('[data-calendar-scroll] .bg-popover');
	if (grid === null) throw new Error('Missing calendar time grid.');
	vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 700, 24 * 56));
	return grid;
};
const pointer = (type: string, y: number) => new PointerEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: y });

it('retains the time-grid scroll anchor when the displayed date and scale change', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(date);
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, { target, props: { initial: { events: [], view: 'day', date } } });
	try {
		flushSync();
		const scroller = target.querySelector<HTMLElement>('[data-calendar-scroll]');
		if (scroller === null) throw new Error('Missing calendar scroll viewport.');
		expect(scroller.scrollTop).toBe(14 * 56);
		scroller.scrollTop = 100;
		app.set_date(new Date(2026, 10, 7));
		flushSync();
		expect(scroller.scrollTop).toBe(8 * 56);
		app.set_scale(6, 40);
		flushSync();
		expect(scroller.scrollTop).toBe(80);
	} finally {
		await unmount(app);
		target.remove();
		vi.useRealTimers();
	}
});

it('creates, moves and resizes with the actual day and event from the grid', async () => {
	const event = { id: 'meeting', title: 'Meeting', start: new Date(2026, 10, 6, 9), end: new Date(2026, 10, 6, 10) };
	const on_event_create = vi.fn(), on_event_move = vi.fn();
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(EventCalendar, { target, props: { events: [event], view: 'day', date, on_event_create, on_event_move } });
	try {
		flushSync();
		const grid = grid_of(target);
		grid.dispatchEvent(pointer('pointerdown', 12 * 56));
		window.dispatchEvent(pointer('pointermove', 13 * 56));
		window.dispatchEvent(pointer('pointerup', 13 * 56));
		expect(on_event_create).toHaveBeenCalledWith({ start: new Date(2026, 10, 6, 12), end: new Date(2026, 10, 6, 13) });
		const box = target.querySelector<HTMLElement>('[data-event="meeting"]');
		if (box === null) throw new Error('Missing editable event.');
		box.dispatchEvent(pointer('pointerdown', 9 * 56));
		window.dispatchEvent(pointer('pointermove', 10 * 56));
		window.dispatchEvent(pointer('pointerup', 10 * 56));
		expect(on_event_move).toHaveBeenLastCalledWith(event, new Date(2026, 10, 6, 10), new Date(2026, 10, 6, 11));
		const resize = box.querySelector<HTMLElement>('.cursor-s-resize');
		if (resize === null) throw new Error('Missing resize handle.');
		resize.dispatchEvent(pointer('pointerdown', 10 * 56));
		window.dispatchEvent(pointer('pointermove', 11 * 56));
		window.dispatchEvent(pointer('pointerup', 11 * 56));
		expect(on_event_move).toHaveBeenLastCalledWith(event, new Date(2026, 10, 6, 9), new Date(2026, 10, 6, 11));
	} finally {
		await unmount(app);
		target.remove();
	}
});

it('cancels a pointer gesture without writing and releases its handlers when the grid unmounts', async () => {
	const on_event_create = vi.fn();
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(EventCalendar, { target, props: { events: [], view: 'day', date, on_event_create } });
	flushSync();
	const grid = grid_of(target);
	grid.dispatchEvent(pointer('pointerdown', 9 * 56));
	window.dispatchEvent(pointer('pointermove', 10 * 56));
	window.dispatchEvent(pointer('pointercancel', 10 * 56));
	expect(on_event_create).not.toHaveBeenCalled();
	grid.dispatchEvent(pointer('pointerdown', 9 * 56));
	window.dispatchEvent(pointer('pointermove', 10 * 56));
	await unmount(app);
	window.dispatchEvent(pointer('pointerup', 10 * 56));
	expect(on_event_create).not.toHaveBeenCalled();
	target.remove();
});

it('assigns the full overlap count to every event in a lane cluster', () => {
	const event = (id: string, start: number, end: number) => ({ id, title: id, start: new Date(2026, 10, 6, start), end: new Date(2026, 10, 6, end) });
	expect([...lanes([event('first', 9, 11), event('second', 10, 12), event('later', 13, 14)])]).toEqual([
		['first', { lane: 0, of: 2 }], ['second', { lane: 1, of: 2 }], ['later', { lane: 0, of: 1 }]
	]);
});

it('uses snake_case event fields for the all-day band and locked timed-event tooltip', async () => {
	const events: CalendarEvent[] = [
		{ id: 'all-day', title: 'All-day event', start: new Date(2026, 10, 6, 9), end: new Date(2026, 10, 6, 10), all_day: true },
		{ id: 'locked', title: 'Locked event', start: new Date(2026, 10, 6, 11), end: new Date(2026, 10, 6, 12), editable: false, locked_reason: 'Published schedule' }
	];
	const on_event_click = vi.fn(), on_event_move = vi.fn();
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(EventCalendar, { target, props: { events, view: 'day', date, on_event_click, on_event_move } });
	try {
		flushSync();
		expect(target.querySelector('[data-event="all-day"]')?.tagName).toBe('BUTTON');
		const locked = target.querySelector<HTMLElement>('[data-event="locked"]');
		if (locked === null) throw new Error('Missing locked event.');
		expect(locked.getAttribute('title')).toBe('Published schedule');
		locked.click();
		expect(on_event_click).toHaveBeenCalledWith(events[1]);
		locked.dispatchEvent(pointer('pointerdown', 11 * 56));
		window.dispatchEvent(pointer('pointermove', 12 * 56));
		window.dispatchEvent(pointer('pointerup', 12 * 56));
		expect(on_event_move).not.toHaveBeenCalled();
	} finally {
		await unmount(app);
		target.remove();
	}
});
