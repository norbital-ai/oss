import type { CalendarEvent, CalendarView, EventChunk, LaneAssignment } from './types.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

export function startOfWeek(date: Date): Date {
	const d = new Date(date);
	const day = d.getDay();
	const diff = d.getDate() - day + (day === 0 ? -6 : 1);
	d.setDate(diff);
	d.setHours(0, 0, 0, 0);
	return d;
}

export function startOfMonth(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function daysInMonth(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

export function weeksInMonth(date: Date): number {
	const start = startOfWeek(startOfMonth(date));
	const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
	const endWeekStart = startOfWeek(end);
	return Math.round((endWeekStart.getTime() - start.getTime()) / (MS_PER_DAY * 7)) + 1;
}

export function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

export function isWeekend(date: Date): boolean {
	const d = date.getDay();
	return d === 0 || d === 6;
}

export function isMultiDayEvent(event: CalendarEvent): boolean {
	if (event.allDay) return true;
	const span = event.end.getTime() - event.start.getTime();
	return span >= MS_PER_DAY || !isSameDay(event.start, event.end);
}

export function addDays(date: Date, days: number): Date {
	const d = new Date(date);
	d.setDate(d.getDate() + days);
	return d;
}

export function dateToPixels(
	date: Date,
	baseDate: Date,
	hourHeight: number,
	startHour: number
): number {
	const base = new Date(baseDate);
	base.setHours(startHour, 0, 0, 0);
	const diff = date.getTime() - base.getTime();
	return (diff / MS_PER_MINUTE) * (hourHeight / 60);
}

export function pixelsToDate(
	pixels: number,
	baseDate: Date,
	hourHeight: number,
	startHour: number,
	snapMinutes: number
): Date {
	const base = new Date(baseDate);
	base.setHours(startHour, 0, 0, 0);
	const minutes = Math.round(pixels / (hourHeight / 60) / snapMinutes) * snapMinutes;
	return new Date(base.getTime() + minutes * MS_PER_MINUTE);
}

export function snapToMinutes(date: Date, minutes: number): Date {
	const ms = minutes * MS_PER_MINUTE;
	return new Date(Math.round(date.getTime() / ms) * ms);
}

export function navigateView(view: CalendarView, date: Date, direction: 'prev' | 'next'): Date {
	const d = new Date(date);
	switch (view) {
		case 'day':
			d.setDate(d.getDate() + (direction === 'next' ? 1 : -1));
			break;
		case 'week':
			d.setDate(d.getDate() + (direction === 'next' ? 7 : -7));
			break;
		case 'month':
			d.setMonth(d.getMonth() + (direction === 'next' ? 1 : -1));
			break;
	}
	return d;
}

export function assignLanes(events: CalendarEvent[]): LaneAssignment[] {
	const sorted = [...events].sort((a, b) => {
		const startDiff = a.start.getTime() - b.start.getTime();
		if (startDiff !== 0) return startDiff;
		return b.end.getTime() - a.end.getTime();
	});

	const lanes: { end: number }[] = [];
	const result: LaneAssignment[] = [];

	for (const event of sorted) {
		let lane = -1;
		for (let i = 0; i < lanes.length; i++) {
			if (lanes[i].end <= event.start.getTime()) {
				lane = i;
				break;
			}
		}
		if (lane === -1) {
			lane = lanes.length;
			lanes.push({ end: event.end.getTime() });
		}
		lanes[lane].end = event.end.getTime();
		result.push({ event, lane, totalLanes: lanes.length });
	}

	return result;
}

export function chunkWeekEvents(events: CalendarEvent[], weekStart: Date): EventChunk[] {
	const chunks: EventChunk[] = [];

	for (const event of events) {
		if (event.allDay || isMultiDayEvent(event)) {
			const evStart = new Date(Math.max(event.start.getTime(), weekStart.getTime()));
			const weekEnd = new Date(weekStart.getTime() + 7 * MS_PER_DAY);
			const evEnd = new Date(Math.min(event.end.getTime(), weekEnd.getTime()));

			let cursor = new Date(evStart);
			let col = 0;
			while (cursor < evEnd && col < 7) {
				const dayStart = new Date(weekStart);
				dayStart.setDate(dayStart.getDate() + col);
				dayStart.setHours(0, 0, 0, 0);

				const dayEnd = new Date(dayStart);
				dayEnd.setDate(dayEnd.getDate() + 1);

				const chunkStart = new Date(Math.max(cursor.getTime(), dayStart.getTime()));
				const chunkEnd = new Date(Math.min(evEnd.getTime(), dayEnd.getTime()));

				if (chunkStart < chunkEnd) {
					chunks.push({
						id: `${event.id}#${col}`,
						event,
						start: chunkStart,
						end: chunkEnd,
						column: col,
						isEdgeStart: col === 0 || !event.allDay,
						isEdgeEnd: col === 6 || chunkEnd.getTime() >= evEnd.getTime()
					});
				}

				cursor = new Date(dayEnd);
				col++;
			}
		}
	}

	return chunks;
}

export function getMonthGrid(date: Date): { days: Date[]; weekCount: number } {
	const monthStart = startOfMonth(date);
	const gridStart = startOfWeek(monthStart);
	const gridEnd = addDays(gridStart, weeksInMonth(date) * 7);

	const days: Date[] = [];
	let cursor = new Date(gridStart);
	while (cursor < gridEnd) {
		days.push(new Date(cursor));
		cursor = addDays(cursor, 1);
	}

	return { days, weekCount: days.length / 7 };
}

export function getColumnDate(weekStart: Date, column: number): Date {
	return addDays(weekStart, column);
}

export function generateTimeSlots(
	startHour: number,
	endHour: number,
	stepMinutes: number
): string[] {
	const slots: string[] = [];
	for (let h = startHour; h < endHour; h++) {
		for (let m = 0; m < 60; m += stepMinutes) {
			const hour = h + Math.floor(m / 60);
			const min = m % 60;
			const label = `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
			slots.push(label);
		}
	}
	return slots;
}

export function formatTimeLabel(date: Date, use24h: boolean = false): string {
	const hours = date.getHours();
	const minutes = date.getMinutes();
	if (use24h) {
		return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
	}
	const period = hours >= 12 ? 'PM' : 'AM';
	const displayHour = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
	return `${displayHour}${minutes > 0 ? ':' + minutes.toString().padStart(2, '0') : ''} ${period}`;
}

export function eventTimeLabel(event: CalendarEvent): string {
	return `${formatTimeLabel(event.start)} – ${formatTimeLabel(event.end)}`;
}
