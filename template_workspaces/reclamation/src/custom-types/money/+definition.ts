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
	description:
		'A finite amount paired with its ISO 4217 currency code, stored together so a rate, a subtotal and a total can never be summed across currencies.',
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
