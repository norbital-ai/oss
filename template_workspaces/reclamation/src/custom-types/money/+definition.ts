import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export interface MoneyOptions {
	readonly allowedCurrencies?: readonly [string, ...string[]];
}

const moneyValueSchema = {
	value: z.number().finite(),
	currency: z
		.string()
		.trim()
		.regex(/^[A-Z]{3}$/, 'Currency must be an ISO 4217 code.')
};

export default defineCustomType({
	name: 'money',
	schema: (options: MoneyOptions = {}) =>
		z
			.object({
				...moneyValueSchema,
				currency: options.allowedCurrencies
					? z.enum(options.allowedCurrencies)
					: moneyValueSchema.currency
			})
			.strict()
});
