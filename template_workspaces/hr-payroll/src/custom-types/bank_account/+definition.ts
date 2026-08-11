import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

export const bankAccountSchema = z.strictObject({
	bank_name: z.string().check(z.trim(), z.minLength(1)),
	bank_code: z.string().check(z.trim(), z.minLength(1)),
	bank_account_number: z.string().check(z.trim(), z.minLength(1)),
	bank_account_name: z.string().check(z.trim(), z.minLength(1))
});
export const bankAccountDraftSchema = z.nullable(z.partial(bankAccountSchema));

export type BankAccount = z.infer<typeof bankAccountSchema>;

export default defineCustomType({
	name: 'bank_account',
	description:
		'The bank name, bank code, account number and account holder name a salary payment is credited to.',
	schema: bankAccountSchema
});
