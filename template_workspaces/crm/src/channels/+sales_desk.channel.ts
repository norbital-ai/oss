import type { Channel } from './$types.js';

/**
 * The sales desk reached over Telegram.
 *
 * The agent answers here under the sales rep policy, so a message from a customer can reach quote and
 * account data without the channel becoming a way around the permission model.
 */
export default {
	transport: 'telegram',
	policy: 'sales_rep',
	description: 'Customer-facing sales enquiries',
	audience: 'public',
	rateLimits: {
		perSenderPerMinute: 8,
		totalPerMinute: 300
	},
	groupMessages: 'disabled',
	task: 'Answer questions about quotes and accounts for this customer.'
} satisfies Channel;
