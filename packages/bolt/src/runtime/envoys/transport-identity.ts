import { Option, Schema } from 'effect';

/**
 * A messaging identity someone has proven is theirs, as stored on `user.channels`.
 *
 * One shape for every transport — `{ type, address, verified }` — rather than a variant per
 * transport carrying its own differently-named address field (`number`, `username`, `slack_user_id`).
 * The deleted Core implementation had the latter, and with it a `storedTransportIdentity` switch
 * whose five arms all did the same thing: return the one string that identifies the person on that
 * wire. A union earns its keep when the arms differ; these do not.
 *
 * `verified` is a stored fact and not an implication of the row existing. An administrator recording
 * a contractor's number is a *claim*; only a completed proof of possession makes it an identity, and
 * the two must be distinguishable or the address book becomes a way to be someone else. Resolution
 * matches on `verified === true` alone, so an unproven claim sits inert.
 *
 * **Holding one of these confers nothing.** It answers "is this sender someone we know" and stops
 * there. What a turn may then read or write comes from the envoy's declared `policies`, always, for
 * a linked sender exactly as for an anonymous one.
 */
export const TransportIdentity = Schema.Struct({
	/** The transport this address is on, matching an envoy's declared `transport`. */
	type: Schema.NonEmptyString,
	/** The address itself, as the transport spells it. Canonicalised on comparison, not on storage. */
	address: Schema.NonEmptyString,
	verified: Schema.Boolean
});
export interface TransportIdentity extends Schema.Schema.Type<typeof TransportIdentity> {}

/**
 * The comparable form of one address on one transport.
 *
 * Two spellings of the same phone number must match and two different numbers must not, and the
 * transports disagree about what is decoration. WhatsApp addresses a sender as a JID — `6591234567@s.whatsapp.net`
 * — while an administrator types `+65 9123 4567`, so for a number-shaped transport everything that is
 * not a digit is noise and the domain is not part of the identity. Handle-shaped transports keep
 * their characters and fold case, because `@Alice` and `@alice` are one Telegram account.
 *
 * Canonicalising on comparison rather than on storage is deliberate: what an operator typed is worth
 * showing back to them unaltered, and a rule that changed later could not be reapplied to rows it had
 * already rewritten.
 */
export const canonicalTransportIdentity = (transport: string, value: string): string => {
	// A leading `@` is a sigil, not a domain separator. Stripping it *before* the split is what
	// distinguishes `@alice` — a handle somebody typed with the sigil — from `alice@host`, where the
	// `@` really does begin a domain. Splitting first turned `@Alice` into the empty string, which
	// was worse than a wrong answer: see `identityMatches` for why an empty canonical form is unsafe.
	const sigilless = value.startsWith('@') ? value.slice(1) : value;
	const beforeDomain = sigilless.split('@', 1)[0] ?? sigilless;
	if (transport === 'whatsapp' || transport === 'phone') return beforeDomain.replace(/\D/g, '');
	return beforeDomain.trim().toLowerCase();
};

/**
 * Whether this stored identity is a proven match for a sender's address on this transport.
 *
 * The transport is compared before the address, so a verified Telegram handle that happens to
 * canonicalise to the same digits as a phone number is not a match for the phone.
 */
export const identityMatches = (
	identity: TransportIdentity,
	transport: string,
	senderAddress: string
): boolean => {
	if (!identity.verified || identity.type !== transport) return false;
	const stored = canonicalTransportIdentity(transport, identity.address);
	const sender = canonicalTransportIdentity(transport, senderAddress);
	/**
	 * An address with no canonical form matches nothing, including another one with no canonical form.
	 *
	 * This is the load-bearing half. Canonicalisation reduces an address to its identifying part, and
	 * anything with none of one — a handle that was only a sigil, a "number" with no digits — reduces
	 * to the empty string. Comparing those by equality would make every such address equal to every
	 * other, so one malformed stored identity would match any malformed sender and hand them that
	 * account. Two unidentifiable things are not the same thing.
	 */
	return stored !== '' && sender !== '' && stored === sender;
};

/**
 * The identities on one `user.channels` value, ignoring anything that is not one.
 *
 * The column is `jsonb` and nothing constrains what a hand-written row may put there, so a malformed
 * entry drops out rather than failing the read. A sender is then simply unrecognised — which on an
 * `authenticated` envoy means a registration prompt, the same safe answer an unknown number gets.
 * The alternative, failing the whole lookup, would take an envoy down over one bad row. It is why
 * the entries are decoded one at a time rather than as a list: one bad entry must not sink the ones
 * beside it.
 */
const decodeIdentity = Schema.decodeUnknownOption(TransportIdentity);

export const identitiesOf = (value: unknown): ReadonlyArray<TransportIdentity> => {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const decoded = decodeIdentity(entry);
		return Option.isSome(decoded) ? [decoded.value] : [];
	});
};
