import { currencyFractionDigits } from './currency.js';

export type MoneyAmount = { value: number; currency: string };

export function amount(value: number, currency: string): MoneyAmount {
	return { value, currency: currency.toUpperCase() };
}

export function assertSameCurrency(a: MoneyAmount, b: MoneyAmount): void {
	if (a.currency !== b.currency) {
		throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
	}
}

export function addAmount(a: MoneyAmount, b: MoneyAmount): MoneyAmount {
	assertSameCurrency(a, b);
	return amount(a.value + b.value, a.currency);
}

export function sumAmounts(items: MoneyAmount[], currency: string): MoneyAmount {
	let total = 0;
	for (const item of items) {
		if (item.currency !== currency) {
			throw new Error(`Currency mismatch in sum: expected ${currency}, got ${item.currency}`);
		}
		total += item.value;
	}
	return amount(total, currency);
}

export function formatAmount(value: number, currency: string, locale = 'en-US'): string {
	const digits = currencyFractionDigits(currency);
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: currency.toUpperCase(),
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	}).format(value);
}

export function toMinorUnits(value: number, currency: string): bigint {
	const digits = currencyFractionDigits(currency);
	const factor = 10 ** digits;
	return BigInt(Math.round(value * factor));
}

export function fromMinorUnits(minor: bigint, currency: string): number {
	const digits = currencyFractionDigits(currency);
	const factor = 10 ** digits;
	return Number(minor) / factor;
}
