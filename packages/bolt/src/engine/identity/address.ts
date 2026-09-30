// What a person signs in with: an email address or a mobile number (§5.11.2). A member may hold either or both; each is
// unique among members, and a code proves one of them.

/** An email address as typed (compared case-folded), or a mobile number in international form (`+` and its digits). */
export type Address = { readonly kind: 'email'; readonly value: string } | { readonly kind: 'phone'; readonly value: string };

/**
 * Reads what a person typed: an email address, or a mobile number with its country code (`+65 8123 4567`; spaces,
 * dashes, dots and brackets are ignored). `null` for anything else — a number without its country code is ambiguous.
 */
export function parseAddress(raw: string): Address | null {
	const text = raw.trim();
	if (text.includes('@')) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) ? { kind: 'email', value: text } : null;
	const phone = text.replace(/[\s\-().]/g, '');
	return /^\+[1-9]\d{7,14}$/.test(phone) ? { kind: 'phone', value: phone } : null;
}

/** The comparable form: a case-folded email, or `tel:` and the number's digits. Keys a challenge and its rate bucket. */
export const addressKey = (a: Address): string => a.kind === 'email' ? a.value.toLowerCase() : `tel:${digits(a.value)}`;

/** A number's digits: how `sys_user.phone_key` and a WhatsApp handle compare phones. */
export const digits = (phone: string): string => phone.replace(/\D/g, '');

/** The member column an address is found by, and the SQL that compares it with a bound `$`. */
export const memberColumn = (a: Address, param: string): string =>
	a.kind === 'email' ? `lower(email) = ${param}` : `phone_key = ${param}`;
/** The bound value `memberColumn` compares with. */
export const memberValue = (a: Address): string => a.kind === 'email' ? a.value.toLowerCase() : digits(a.value);

export const ADDRESS_HINT = 'Enter an email address, or a mobile number with its country code (+65 8123 4567).';
