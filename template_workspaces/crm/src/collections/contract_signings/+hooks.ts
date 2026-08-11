import type { Hooks } from './$types.js';

type SigningStatus = 'unstamped' | 'counterparty_stamped' | 'acknowledged' | 'voided';

const VALID_TRANSITIONS: Record<SigningStatus, readonly SigningStatus[]> = {
	unstamped: ['counterparty_stamped', 'voided'],
	counterparty_stamped: ['acknowledged', 'voided'],
	acknowledged: ['voided'],
	voided: []
};

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Fingerprint the quote substance a contract is bound to. */
async function bindingHashFor(
	api: Parameters<NonNullable<NonNullable<Hooks['create']>['before']>['handler']>[0]['api'],
	quoteId: string
): Promise<string> {
	const quote = await api.db.query.quotes.findFirst({
		where: { norbital_id: { eq: quoteId } },
		columns: {
			account_id: true,
			currency: true,
			tax_inclusive: true,
			net: true,
			tax: true,
			gross: true
		}
	});
	const lines = await api.db.query.quote_lines.findMany({
		where: { quote_id: { eq: quoteId } },
		columns: {
			product_code: true,
			quantity: true,
			unit_price: true,
			tax_rate: true,
			line_total: true
		},
		orderBy: { product_code: 'asc' },
		limit: 5000
	});
	return sha256Hex(JSON.stringify({ quote, lines }));
}

export default {
	create: {
		before: {
			description:
				'Raises a signing only from a confirmed quote with no other live signing, and fingerprints the quote header and lines into binding_hash so later edits are detectable.',
			handler: async ({ input, api }) => {
				if (!input.quote_id) throw new Error('A contract signing must reference a quote.');
				const quote = await api.db.query.quotes.findFirst({
					where: { norbital_id: { eq: input.quote_id } }
				});
				if (!quote) throw new Error('Referenced quote does not exist.');
				if (quote.status !== 'confirmed') {
					throw new Error('A contract can only be generated from a confirmed quote.');
				}

				const existing = await api.db.query.contract_signings.findMany({
					where: { quote_id: { eq: input.quote_id } },
					columns: { status: true },
					limit: 5000
				});
				if (existing.some((signing) => signing.status !== 'voided')) {
					throw new Error(
						'An active contract signing already exists for this quote. Void it before re-signing.'
					);
				}

				return {
					...input,
					status: input.status ?? 'unstamped',
					variant: input.variant ?? 'advance',
					binding_hash: await bindingHashFor(api, input.quote_id)
				};
			}
		}
	},
	update: {
		before: {
			description:
				'Walks a signing from unstamped to counterparty-stamped to acknowledged, demanding the counterparty file to stamp, a still-confirmed quote to acknowledge, and a reason to void.',
			handler: async ({ input, existing, api }) => {
				const newStatus = (input.status ?? existing.status) as SigningStatus;
				const oldStatus = existing.status as SigningStatus;

				if (oldStatus === newStatus) {
					if (oldStatus === 'voided') {
						throw new Error('A voided contract signing is immutable.');
					}
					return input;
				}

				const allowed = VALID_TRANSITIONS[oldStatus];
				if (!allowed.includes(newStatus)) {
					throw new Error(
						`Invalid status transition: ${oldStatus} → ${newStatus}. Allowed: ${allowed.join(', ')}.`
					);
				}

				const updates: Record<string, unknown> = { ...input };

				if (newStatus === 'counterparty_stamped') {
					const counterpartyFile = input.counterparty_file ?? existing.counterparty_file;
					if (counterpartyFile == null) {
						throw new Error('The counterparty-stamped contract file is required to stamp.');
					}
				}

				if (newStatus === 'acknowledged') {
					const quote = await api.db.query.quotes.findFirst({
						where: { norbital_id: { eq: existing.quote_id } },
						columns: { status: true }
					});
					if (!quote || quote.status !== 'confirmed') {
						throw new Error('The underlying quote is no longer confirmed.');
					}
					if (existing.acknowledged_at == null) updates.acknowledged_at = new Date();
				}

				if (newStatus === 'voided') {
					const voidReason = input.void_reason ?? existing.void_reason;
					if (!voidReason || String(voidReason).trim() === '') {
						throw new Error('A void reason is required.');
					}
				}

				return updates;
			}
		}
	}
} satisfies Hooks;
