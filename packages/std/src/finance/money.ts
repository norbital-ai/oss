import { currencyFractionDigits } from './currency.js';

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
