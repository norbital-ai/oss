import { currencyFractionDigits, fromMinorUnits, toMinorUnits } from '@norbital-ai/std/finance';

/**
 * Quote arithmetic, shared by the quote line hooks and the quote rollup.
 *
 * Two rules matter more than the formulas and are the reason this is one module rather than a helper
 * per collection. First, rounding happens at named points only: a line is rounded once, and a
 * document total is the sum of already-rounded lines. Summing unrounded lines and rounding at the end
 * produces a total that disagrees with the printed lines by a cent or two, which is the classic
 * reconciliation defect. Second, the scale is the currency's, not a hardcoded 2 — JPY has no minor
 * unit, and a two-decimal assumption silently inflates every yen figure by a factor of a hundred.
 */

/**
 * Half-up rounding to a decimal scale, shifting through the exponent rather than multiplying.
 *
 * `1.005 * 100` is `100.49999999999999` in binary floating point, so the naive
 * `Math.round(value * factor)` rounds a half *down* for a subset of inputs that includes ordinary
 * prices. Shifting the exponent of the decimal representation avoids introducing that error.
 */
export function roundHalfUp(value: number, digits: number): number {
	if (!Number.isFinite(value)) {
		throw new Error('Cannot round a value that is not a finite number.');
	}
	const magnitude = Math.abs(shiftExponent(value, digits));
	const rounded = Math.round(magnitude);
	return shiftExponent(value < 0 ? -rounded : rounded, -digits);
}

function shiftExponent(value: number, places: number): number {
	if (value === 0) return 0;
	const [mantissa, exponent] = value.toExponential().split('e');
	return Number(`${mantissa}e${Number(exponent) + places}`);
}

export interface LinePricing {
	readonly quantity: number;
	readonly unit_price: number;
	readonly discount_pct?: number | null;
	readonly tax_rate?: number | null;
	readonly tax_inclusive: boolean;
	readonly currency: string;
}

export interface LineAmounts {
	readonly net: number;
	readonly tax: number;
	readonly gross: number;
}

/**
 * Price one line.
 *
 * Tax-exclusive documents treat net as primary and derive tax from it. Tax-inclusive documents treat
 * gross as primary and take tax as the *residual* — `gross - net` rather than a second rounded
 * multiplication — so that net, tax and gross always add up exactly as printed.
 */
export function lineAmounts(line: LinePricing): LineAmounts {
	const digits = currencyFractionDigits(line.currency);
	const discount = line.discount_pct ?? 0;
	const rate = (line.tax_rate ?? 0) / 100;
	const base = line.quantity * line.unit_price * (1 - discount / 100);

	if (line.tax_inclusive) {
		const gross = roundHalfUp(base, digits);
		const net = roundHalfUp(gross / (1 + rate), digits);
		return { net, tax: roundHalfUp(gross - net, digits), gross };
	}

	const net = roundHalfUp(base, digits);
	const tax = roundHalfUp(net * rate, digits);
	return { net, tax, gross: roundHalfUp(net + tax, digits) };
}

/** Sum already-rounded lines in minor units, so no float drift accumulates across a long document. */
export function documentTotals(lines: readonly LineAmounts[], currency: string): LineAmounts {
	let net = 0n;
	let tax = 0n;
	let gross = 0n;
	for (const line of lines) {
		net += toMinorUnits(line.net, currency);
		tax += toMinorUnits(line.tax, currency);
		gross += toMinorUnits(line.gross, currency);
	}
	return {
		net: fromMinorUnits(net, currency),
		tax: fromMinorUnits(tax, currency),
		gross: fromMinorUnits(gross, currency)
	};
}
