export type RepaymentInstalmentLink = {
	readonly amount: unknown;
	readonly repayment_sequence: number | null;
	readonly entry_payslip_sources?: readonly unknown[] | null;
};

export type RepaymentProgress = {
	readonly paidAmount: number;
	readonly outstandingAmount: number;
	readonly paidInstalments: number;
	readonly totalInstalments: number;
	readonly settled: boolean;
};

/**
 * Derive repayment progress from the agreement's nested instalment relation.
 *
 * An instalment is paid when payroll persisted at least one source link to it. Duplicate source
 * rows cannot double-count an instalment: sequence is the schedule identity and is counted once.
 */
export function repaymentProgress(
	principal: unknown,
	totalInstalments: number,
	instalments: readonly RepaymentInstalmentLink[]
): RepaymentProgress | null {
	const total = Number(principal);
	if (!Number.isFinite(total) || total < 0) return null;

	const paidBySequence = new Map<number, number>();
	for (const instalment of instalments) {
		if (!instalment.entry_payslip_sources?.length) continue;
		if (!Number.isInteger(instalment.repayment_sequence)) continue;
		const amount = Number(instalment.amount);
		if (!Number.isFinite(amount) || amount < 0) continue;
		const sequence = instalment.repayment_sequence as number;
		if (!paidBySequence.has(sequence)) paidBySequence.set(sequence, amount);
	}

	const paidAmount = [...paidBySequence.values()].reduce((sum, amount) => sum + amount, 0);
	const outstandingAmount = Math.max(0, total - paidAmount);
	const paidInstalments = paidBySequence.size;
	return {
		paidAmount,
		outstandingAmount,
		paidInstalments,
		totalInstalments,
		settled: outstandingAmount === 0 && paidInstalments >= totalInstalments
	};
}
