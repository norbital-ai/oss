import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

export interface MoneyOptions {
	readonly allowedCurrencies?: readonly [string, ...string[]];
}

const moneyValueSchema = {
	value: z.number(),
	currency: z.string().check(z.trim(), z.regex(/^[A-Z]{3}$/, 'Currency must be an ISO 4217 code.'))
};

export function moneySchema(options: MoneyOptions = {}) {
	return z.strictObject({
		...moneyValueSchema,
		currency: options.allowedCurrencies
			? z.enum(options.allowedCurrencies)
			: moneyValueSchema.currency
	});
}

export default defineCustomType({
	name: 'money',
	schema: moneySchema
});
