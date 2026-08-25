import type { TeamName } from './contracts-schema.js';

const ApprovalFlowBrand: unique symbol = Symbol('@norbital-ai/bolt/ApprovalFlow');

type ApprovalStage = Readonly<{
	readonly approvers: readonly [TeamName, ...TeamName[]];
}>;

export type ApprovalFlow = ApprovalReviewFlow | NoApprovalFlow;

export type ApprovalReviewFlow = Readonly<{
	readonly _tag: 'Review';
	readonly stages: ReadonlyArray<ApprovalStage>;
	readonly thenBy: (first: TeamName, ...others: ReadonlyArray<TeamName>) => ApprovalReviewFlow;
	readonly [ApprovalFlowBrand]: true;
}>;

export type NoApprovalFlow = Readonly<{
	readonly _tag: 'NoApproval';
	readonly [ApprovalFlowBrand]: true;
}>;

type ApprovalFlowDescriptor =
	| Readonly<{ readonly _tag: 'NoApproval' }>
	| Readonly<{
			readonly _tag: 'Review';
			readonly stages: ReadonlyArray<Readonly<{ readonly approvers: ReadonlyArray<string> }>>;
	  }>;

const approvers = (
	first: TeamName,
	others: ReadonlyArray<TeamName>
): readonly [TeamName, ...TeamName[]] => {
	const values = [first, ...others];
	if (values.some((value) => typeof value !== 'string' || value.trim() === '')) {
		throw new TypeError('An approval stage requires at least one non-empty team name.');
	}
	if (new Set(values).size !== values.length) {
		throw new TypeError('An approval stage cannot name the same team twice.');
	}
	return Object.freeze(values) as readonly [TeamName, ...TeamName[]];
};

const review = (stages: ReadonlyArray<ApprovalStage>): ApprovalReviewFlow =>
	Object.freeze({
		_tag: 'Review' as const,
		stages: Object.freeze([...stages]),
		thenBy: (first: TeamName, ...others: ReadonlyArray<TeamName>) =>
			review([...stages, Object.freeze({ approvers: approvers(first, others) })]),
		[ApprovalFlowBrand]: true as const
	});

/** Starts a concrete review flow. Teams listed in one stage are alternatives; stages are sequential. */
export const approveBy = (
	first: TeamName,
	...others: ReadonlyArray<TeamName>
): ApprovalReviewFlow => review([Object.freeze({ approvers: approvers(first, others) })]);

/** Explicitly selects the branch in which this write needs no review. */
export const noApproval: NoApprovalFlow = Object.freeze({
	_tag: 'NoApproval',
	[ApprovalFlowBrand]: true as const
});

/** Removes fluent methods and the nominal brand at the live-code boundary. */
export const approvalFlowDescriptor = (value: unknown): ApprovalFlowDescriptor | undefined => {
	if (typeof value !== 'object' || value === null || !Reflect.has(value, ApprovalFlowBrand))
		return undefined;
	if (Reflect.get(value, '_tag') === 'NoApproval') return Object.freeze({ _tag: 'NoApproval' });
	if (Reflect.get(value, '_tag') !== 'Review') return undefined;
	const stages = Reflect.get(value, 'stages');
	if (!Array.isArray(stages) || stages.length === 0) return undefined;
	const described = stages.map(
		(stage): Readonly<{ approvers: ReadonlyArray<string> }> | undefined => {
			if (typeof stage !== 'object' || stage === null) return undefined;
			const values = Reflect.get(stage, 'approvers');
			if (
				!Array.isArray(values) ||
				values.length === 0 ||
				values.some((team) => typeof team !== 'string' || team.trim() === '') ||
				new Set(values).size !== values.length
			)
				return undefined;
			return Object.freeze({ approvers: Object.freeze([...values]) });
		}
	);
	if (described.some((stage) => stage === undefined)) return undefined;
	return Object.freeze({
		_tag: 'Review',
		stages: Object.freeze(
			described as ReadonlyArray<Readonly<{ readonly approvers: ReadonlyArray<string> }>>
		)
	});
};
