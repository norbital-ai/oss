import { z } from 'zod';

/** Telephone number stored by the built-in `phone()` text column. */
export const phoneZodSchema = z.string();

export type PhoneZod = z.infer<typeof phoneZodSchema>;
export type TPhone = PhoneZod;
