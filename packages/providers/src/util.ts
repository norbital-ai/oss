// The few helpers every provider shares: reading untrusted JSON, comparing secrets in constant time, outbound attachments.
import { timingSafeEqual } from 'node:crypto';
import { SendRefused, type Json, type OutboundAttachment } from '@norbital-ai/bolt/engine';

export type Obj = { readonly [k: string]: Json };
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v : null;
/** Equal in constant time; an empty `want` never matches. */
export const same = (got: string, want: string): boolean => {
	const a = Buffer.from(got), b = Buffer.from(want);
	return want !== '' && a.length === b.length && timingSafeEqual(a, b);
};
/**
 * A provider API's refusal as an error: a 4xx other than 429 is permanent (`SendRefused`), so bolt fails the send at once
 * instead of retrying it; anything else is retried. `code` is the provider's own error code, else the HTTP status.
 */
export const refusal = (message: string, status: number, code?: string): Error =>
	status >= 400 && status < 500 && status !== 429 ? new SendRefused(message, code ?? String(status)) : new Error(message);
/** A setup field the operator must fill, or the refusal the shell shows verbatim. */
export const field = (input: Json, name: string, label: string, shape?: RegExp): string => {
	const v = isObj(input) ? input[name] : undefined;
	if (typeof v !== 'string' || v.trim() === '') throw new Error(`${label} is required`);
	if (shape !== undefined && !shape.test(v.trim())) throw new Error(`${label} does not look right`);
	return v.trim();
};
/** An attachment bolt read for a send, as a multipart file part. */
export const blobOf = (a: OutboundAttachment): Blob => new Blob([a.bytes.slice()], { type: a.mime });
/** A signed link to an attachment for a provider that fetches media itself; a host that serves none refuses the send for good. */
export const linkOf = async (a: OutboundAttachment, expiresInS = 86_400): Promise<string> => {
	try { return await a.url(expiresInS); } catch { throw new SendRefused(`${a.name}: this host serves no file link the provider can fetch`); }
};
