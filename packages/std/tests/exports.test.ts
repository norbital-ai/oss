import assert from 'node:assert/strict';
import { test } from 'node:test';

// §3.7 / Appendix D.2: the 0.0.1 entries resolve to the builds (run after `pnpm build`).
test('std 0.0.1 entries point at the builds', async () => {
	const want: { [entry: string]: string[] } = {
		decimal: ['Decimal', 'dec', 'sum', 'currency', 'minorDigits'], date: ['PlainDate', 'datePeriod', 'formatPeriod', 'parseInstant'],
		calendar: ['cycleOf', 'businessDays', 'WorkCalendar'], sheet: ['columns', 'decode', 'encode'], versioned: ['sealWrites', 'cloneNext'],
		json: ['parseJson'], pdf: [], facts: ['facts', 'validateFacts'], label: ['label'], billing: ['LATEST_CATALOGUE'], zone: ['localOf', 'utcOf'],
	};
	for (const [entry, names] of Object.entries(want)) {
		const url = import.meta.resolve(`@norbital-ai/std/${entry}`);
		if (entry !== 'billing') assert.match(url, new RegExp(`/build/${entry}\\.js$`), entry);
		const m = await import(url) as { [k: string]: unknown };
		for (const n of names) assert.ok(n in m, `${entry} exports ${n}`);
	}
});
