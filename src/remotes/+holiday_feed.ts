import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import type { Api } from './$types.js';

/**
 * Public-holiday suggestions for one company's jurisdiction, read from Google's public holiday
 * calendars. Nothing is written: the operator still authors `company_holidays` rows, because a
 * company observes a subset of the national calendar and may add its own regional days.
 */
const GOOGLE_PUBLIC_HOLIDAY_CALENDAR_IDS: Record<string, string> = {
	SG: 'en.singapore#holiday@group.v.calendar.google.com',
	MY: 'en.malaysia#holiday@group.v.calendar.google.com',
	TH: 'en.th#holiday@group.v.calendar.google.com',
	VN: 'en.vietnamese#holiday@group.v.calendar.google.com',
	PH: 'en.philippines#holiday@group.v.calendar.google.com',
	ID: 'en.indonesian#holiday@group.v.calendar.google.com',
	JP: 'en.japanese#holiday@group.v.calendar.google.com',
	TW: 'en.taiwan#holiday@group.v.calendar.google.com',
	CN: 'en.china#holiday@group.v.calendar.google.com'
};

function googleCalendarIdForCountry(countryCode: string): string | null {
	return GOOGLE_PUBLIC_HOLIDAY_CALENDAR_IDS[countryCode.trim().toUpperCase()] ?? null;
}

function googleCalendarIcalUrl(calendarId: string): string {
	return `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;
}

function unfoldIcalLines(icalText: string): string[] {
	const raw = icalText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	const lines: string[] = [];
	for (const line of raw) {
		if (line.startsWith(' ') || line.startsWith('\t')) {
			if (lines.length > 0) lines[lines.length - 1] += line.slice(1);
			continue;
		}
		lines.push(line);
	}
	return lines;
}

function parseIcalDateValue(value: string): string | null {
	const dateOnly = value.trim().match(/^(\d{4})(\d{2})(\d{2})/);
	if (!dateOnly) return null;
	const [, year, month, day] = dateOnly;
	return `${year}-${month}-${day}T00:00:00.000Z`;
}

function eventYear(isoDate: string): number | null {
	const parsed = Date.parse(isoDate);
	if (Number.isNaN(parsed)) return null;
	return new Date(parsed).getUTCFullYear();
}

type IcalHolidayEvent = {
	readonly google_event_uid: string;
	readonly date: string;
	readonly name: string;
};

function parseIcalHolidayEvents(icalText: string, calendarYear: number): IcalHolidayEvent[] {
	const events: IcalHolidayEvent[] = [];
	let inEvent = false;
	let uid: string | null = null;
	let summary: string | null = null;
	let dtStart: string | null = null;

	function flushEvent(): void {
		if (!uid || !summary || !dtStart) return;
		if (eventYear(dtStart) !== calendarYear) return;
		events.push({ google_event_uid: uid, date: dtStart, name: summary });
	}

	for (const line of unfoldIcalLines(icalText)) {
		if (line === 'BEGIN:VEVENT') {
			inEvent = true;
			uid = null;
			summary = null;
			dtStart = null;
			continue;
		}
		if (line === 'END:VEVENT') {
			if (inEvent) flushEvent();
			inEvent = false;
			continue;
		}
		if (!inEvent) continue;
		if (line.startsWith('UID:')) {
			uid = line.slice('UID:'.length).trim();
			continue;
		}
		if (line.startsWith('SUMMARY:')) {
			summary = line.slice('SUMMARY:'.length).trim();
			continue;
		}
		if (line.startsWith('DTSTART;VALUE=DATE:')) {
			dtStart = parseIcalDateValue(line.slice('DTSTART;VALUE=DATE:'.length));
			continue;
		}
		if (line.startsWith('DTSTART:')) {
			dtStart = parseIcalDateValue(line.slice('DTSTART:'.length));
		}
	}

	events.sort((a, b) => a.date.localeCompare(b.date));
	return events;
}

export default defineQueryHandler({
	schema: z.object({
		company_id: z.string().uuid(),
		year: z.number().int().min(2000).max(2100)
	}),
	handler: async ({ company_id, year }, api: Api) => {
		const company = (
			await api.db.query.companies.findMany({
				where: { norbital_id: { eq: company_id } },
				limit: 1
			})
		)[0];
		if (!company) throw new Error('Holiday feed requires an existing company.');
		const jurisdiction = (
			await api.db.query.jurisdictions.findMany({
				where: { norbital_id: { eq: company.jurisdiction_id } },
				limit: 1
			})
		)[0];
		if (!jurisdiction) throw new Error("Holiday feed requires the company's jurisdiction.");
		const countryCode = jurisdiction.code;
		const calendarId = googleCalendarIdForCountry(countryCode);
		if (calendarId == null) return { country_code: countryCode, holidays: [] };

		const url = googleCalendarIcalUrl(calendarId);
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' || parsed.hostname !== 'calendar.google.com') {
			throw new Error('Holiday remote only supports Google Calendar HTTPS feeds');
		}

		const response = await api.fetch(parsed);
		if (!response.ok) {
			throw new Error(`Google Calendar holiday feed failed (${response.status})`);
		}

		const text = await response.text();
		return {
			country_code: countryCode,
			holidays: parseIcalHolidayEvents(text, year).map((event) => ({
				code: event.google_event_uid,
				date: event.date.slice(0, 10),
				name: event.name
			}))
		};
	}
});
