import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from '@effect/vitest';

// §3.7 / Appendix D.2: the 0.0.1 entries resolve to the builds (run after `pnpm build`).
const build = new URL('../build/', import.meta.url);
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

	// Boundary schemas and synchronous Result parsers use Effect's data modules; std never executes a runtime.
	it('imports effect only for boundary schemas and pure results, and never runs an effect', () => {
		const files = readdirSync(build, { recursive: true, encoding: 'utf8' })
			.filter((f) => f.endsWith('.js'))
			.sort();
		const source = (f: string) => readFileSync(new URL(f, build), 'utf8');
		const importing = files.filter((f) =>
			/from ['"]effect(\/[^'"]*)?['"]|import\(['"]effect/.test(source(f))
		);
		assert.deepEqual(importing, [
			'billing/schemas.js',
			'date.js',
			'formula.js',
			'host-op.js',
			'json.js',
			'kind.js',
			'sheet.js'
		]);
		for (const file of ['billing/index.js', 'billing/rate-card.js'])
			assert.doesNotMatch(source(file), /from ['"]effect(\/[^'"]*)?['"]|import\(['"]effect/, file);
		for (const file of ['formula.js', 'sheet.js']) {
			const dependencies = [
				...source(file).matchAll(/\bimport\s+([^;]+?)\s+from\s+['"](effect(?:\/[^'"]*)?)['"]/g)
			];
			assert.deepEqual(
				dependencies.map((entry) => [entry[1]?.trim(), entry[2]]),
				[['* as Result', 'effect/Result']],
				file
			);
		}
		for (const f of files)
			assert.doesNotMatch(
				source(f),
				/\b(runSync|runPromise|runFork|runCallback|ManagedRuntime)\b/,
				f
			);
	});
});
