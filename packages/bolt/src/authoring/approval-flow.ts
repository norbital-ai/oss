import { Schema } from 'effect';
import type { TeamName } from './contracts-schema.js';
import { ApprovalFlowBrand } from './contracts-schema.js';
import type { ApprovalFlow, ApprovalReviewFlow, NoApprovalFlow } from './contracts-schema.js';

const isString = Schema.is(Schema.String);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

export type { ApprovalFlow, ApprovalReviewFlow, NoApprovalFlow } from './contracts-schema.js';

type ApprovalStage = Readonly<{
	readonly approvers: readonly [TeamName, ...TeamName[]];
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
	if (values.some((value) => !isString(value) || value.trim() === '')) {
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
	if (!isRecord(value) || !Reflect.has(value, ApprovalFlowBrand)) return undefined;
	if (Reflect.get(value, '_tag') === 'NoApproval') return Object.freeze({ _tag: 'NoApproval' });
	if (Reflect.get(value, '_tag') !== 'Review') return undefined;
	const stages = Reflect.get(value, 'stages');
	if (!Array.isArray(stages) || stages.length === 0) return undefined;
	const described = stages.map(
		(stage): Readonly<{ approvers: ReadonlyArray<string> }> | undefined => {
			if (!isRecord(stage)) return undefined;
			const values = Reflect.get(stage, 'approvers');
			if (
				!Array.isArray(values) ||
				values.length === 0 ||
				values.some((team) => !isString(team) || team.trim() === '') ||
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
