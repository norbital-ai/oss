export interface ResourceSchedulerDay {
	readonly key: string;
	readonly label: string;
	readonly start: string;
	readonly end: string;
}

const dayMilliseconds = 86_400_000;

function utcDay(value: string): Date {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid scheduler date: ${value}`);
	return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

export function buildResourceSchedulerDays(
	anchorDate: string,
	view: 'week' | 'month',
	locale = 'en-US'
): ResourceSchedulerDay[] {
	const anchor = utcDay(anchorDate);
	const start = new Date(anchor);
	if (view === 'week') {
		const weekday = start.getUTCDay();
		start.setUTCDate(start.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
	} else {
		start.setUTCDate(1);
	}
	const count =
		view === 'week'
			? 7
			: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
	const formatter = new Intl.DateTimeFormat(locale, {
		weekday: view === 'week' ? 'short' : undefined,
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	});
	return Array.from({ length: count }, (_, index) => {
		const dayStart = new Date(start.getTime() + index * dayMilliseconds);
		const dayEnd = new Date(dayStart.getTime() + dayMilliseconds);
		return {
			key: dayStart.toISOString().slice(0, 10),
			label: formatter.format(dayStart),
			start: dayStart.toISOString(),
			end: dayEnd.toISOString()
		};
	});
}

export function shiftResourceSchedulerInterval(
	start: string,
	end: string,
	days: number,
	resize: 'start' | 'end' | null = null
): { start: string; end: string } {
	const startDate = new Date(start);
	const endDate = new Date(end);
	if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
		throw new Error('Scheduler intervals require valid ISO dates.');
	}
	const delta = days * dayMilliseconds;
	const nextStart = new Date(startDate.getTime() + (resize === 'end' ? 0 : delta));
	const nextEnd = new Date(endDate.getTime() + (resize === 'start' ? 0 : delta));
	if (nextEnd <= nextStart) return { start, end };
	return { start: nextStart.toISOString(), end: nextEnd.toISOString() };
}

export function resourceSchedulerIntervalPosition(
	start: string,
	end: string,
	rangeStart: string,
	dayWidth: number
): { left: number; width: number } {
	const rangeTime = new Date(rangeStart).getTime();
	const startTime = new Date(start).getTime();
	const endTime = new Date(end).getTime();
	return {
		left: ((startTime - rangeTime) / dayMilliseconds) * dayWidth,
		width: Math.max(24, ((endTime - startTime) / dayMilliseconds) * dayWidth)
	};
}
