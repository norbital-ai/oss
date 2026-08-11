import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

const signatureSchema = z
	.object({
		name: z.string(),
		date: z.string()
	})
	.strict();

export const permitSignaturesSchema = z
	.object({
		applicant: signatureSchema.nullable(),
		issuer: signatureSchema.nullable(),
		acceptor: signatureSchema.nullable()
	})
	.strict();

export default defineCustomType({
	name: 'permit_signatures',
	description:
		'The applicant, issuer, and acceptor sign-offs on a permit to work, each a name and a date, with a party who has not yet signed left explicitly empty.',
	schema: permitSignaturesSchema
});
