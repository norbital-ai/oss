/**
 * Host-side receipt settle. Same write Core's `settleReceiptEffect` uses.
 *
 * After a host facility finishes an effect, the next tenant step must see the result on the job.
 * That UPDATE belongs in the host process — not a guest `action: 'settle'` hop.
 */

export const SETTLE_RECEIPT_EFFECT_SQL = `UPDATE _norbital_automation_job
			    SET orchestration_status = 'admitted',
			        continuation = jsonb_build_object(
			          'effects',
			          CASE
			            WHEN EXISTS (
			              SELECT 1
			                FROM jsonb_array_elements(COALESCE(continuation->'effects', '[]'::jsonb)) AS entry
			               WHERE (entry->>'ordinal')::int = $2
			            ) THEN COALESCE(continuation->'effects', '[]'::jsonb)
			            ELSE COALESCE(continuation->'effects', '[]'::jsonb) || $3::jsonb
			          END
			        ),
			        effect_id = NULL,
			        effect_ordinal = NULL,
			        effect_request_hash = NULL,
			        effect_request = NULL,
			        updated_at = CURRENT_TIMESTAMP
			  WHERE norbital_id = $1::uuid
			    AND effect_id = $4`;

export type HostSettleQuery = (sql: string, values: readonly unknown[]) => Promise<unknown>;

export type HostSettleEffect = {
	readonly receiptId: string;
	readonly effectId: string;
	readonly ordinal: number;
	readonly requestHash: string;
};

export type HostSettleOutcome =
	| { readonly status: 'succeeded'; readonly result?: unknown; readonly error?: string }
	| { readonly status: 'failed'; readonly result?: unknown; readonly error?: string };

function settledOutcome(outcome: HostSettleOutcome): HostSettleOutcome {
	if (outcome.status === 'succeeded') {
		return { status: 'succeeded', result: outcome.result };
	}
	if (outcome.status === 'failed') {
		return { status: 'failed', error: outcome.error ?? 'Automation effect failed' };
	}
	const _exhaustive: never = outcome;
	return {
		status: 'failed',
		error: `Automation effect outcome was unreadable: ${JSON.stringify(_exhaustive)}`
	};
}

export async function settleHostReceiptEffect(
	query: HostSettleQuery,
	effect: HostSettleEffect,
	outcome: HostSettleOutcome
): Promise<void> {
	const settled = settledOutcome(outcome);
	const effectRow =
		settled.status === 'succeeded'
			? {
					ordinal: effect.ordinal,
					requestHash: effect.requestHash,
					status: 'succeeded' as const,
					result: settled.result
				}
			: {
					ordinal: effect.ordinal,
					requestHash: effect.requestHash,
					status: 'failed' as const,
					error: settled.error ?? 'Automation effect failed'
				};
	await query(SETTLE_RECEIPT_EFFECT_SQL, [
		effect.receiptId,
		effect.ordinal,
		JSON.stringify(effectRow),
		effect.effectId
	]);
}
