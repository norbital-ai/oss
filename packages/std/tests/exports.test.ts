import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from '@effect/vitest';

// §3.7 / Appendix D.2: the 0.0.1 entries resolve to the builds (run after `pnpm build`).
const manifest: {
	readonly exports: {
		readonly [entry: string]: { readonly types: string; readonly default: string };
	};
} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('std builds', () => {
	it('points every entry at its build, which exports its names', async () => {
		const want: { [entry: string]: string[] } = {
			decimal: ['Decimal', 'dec', 'sum', 'currency', 'minorDigits'],
			date: ['PlainDate', 'datePeriod', 'formatPeriod', 'parseInstant'],
			calendar: ['cycleOf', 'businessDays', 'WorkCalendar'],
			sheet: ['columns', 'decode', 'encode'],
			versioned: ['sealWrites', 'cloneNext'],
			json: ['parseJson', 'parseJsonResult'],
			facts: ['facts', 'validateFacts'],
			label: ['label'],
			billing: [
				'LATEST_CATALOGUE',
				'BILLING_CURRENCY',
				'BillingCatalogueIntervalSchema',
				'BillingCataloguePlanSchema',
				'BillingCataloguePriceModelSchema',
				'BillingCataloguePriceSchema',
				'BillingCatalogueProductSchema',
				'BillingCatalogueProviderPriceIdsSchema',
				'BillingCatalogueSchema',
				'BillingCatalogueTierSchema',
				'BillingProviderEnvironmentSchema'
			],
			zone: ['localOf', 'utcOf'],
			wire: ['reviveWire', 'encodeWire'],
			kind: ['KIND', 'inputSchema'],
			'host-op': ['signOp', 'verifyOp', 'OpRefused', 'OP_HEADERS', 'OP_WINDOW_MS']
		};
		for (const [entry, names] of Object.entries(want)) {
			const target = manifest.exports[`./${entry}`];
			assert.ok(target !== undefined, `std exports ./${entry}`);
			if (entry !== 'billing') assert.equal(target.default, `./build/${entry}.js`, entry);
			const m = (await import(new URL(target.default, new URL('../', import.meta.url)).href)) as {
				[k: string]: unknown;
			};
			for (const n of names) assert.ok(n in m, `${entry} exports ${n}`);
		}
	});
});
