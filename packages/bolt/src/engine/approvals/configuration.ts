import { Schema } from 'effect';
import type { EngineManifest } from '../manifest.ts';

const Predicate = Schema.Record(Schema.String, Schema.Json);
const Handle = Schema.String.check(Schema.isNonEmpty());

export type ApprovalMatchData = {
	readonly record?: typeof Predicate.Type;
	readonly previous?: typeof Predicate.Type;
	readonly changed?: readonly string[];
	readonly requestor?: 'in_team' | 'no_team' | { readonly team: readonly string[] };
	readonly and?: readonly ApprovalMatchData[];
	readonly or?: readonly ApprovalMatchData[];
	readonly not?: ApprovalMatchData;
};

const ApprovalMatchData: Schema.Codec<ApprovalMatchData> = Schema.suspend(() =>
	Schema.Struct({
		record: Schema.optionalKey(Predicate),
		previous: Schema.optionalKey(Predicate),
		changed: Schema.optionalKey(Schema.Array(Handle)),
		requestor: Schema.optionalKey(
			Schema.Union([
				Schema.Literals(['in_team', 'no_team']),
				Schema.Struct({ team: Schema.Array(Handle) })
			])
		),
		and: Schema.optionalKey(Schema.Array(ApprovalMatchData)),
		or: Schema.optionalKey(Schema.Array(ApprovalMatchData)),
		not: Schema.optionalKey(ApprovalMatchData)
	})
);

/** A source approval route, independent of the source grant for direct writes. */
const ApprovalRouteSchema = Schema.Struct({
	match: Schema.optionalKey(ApprovalMatchData),
	where: Schema.optionalKey(Predicate),
	previous: Schema.optionalKey(Predicate),
	fields: Schema.optionalKey(Schema.Array(Handle)),
	steps: Schema.Array(Schema.Array(Handle).check(Schema.isMinLength(1))).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(8)
	),
	superseded_by: Schema.optionalKey(Schema.Array(Handle))
});
export type SourceApprovalRoute = typeof ApprovalRouteSchema.Type;

/** Decode source values without accepting an empty or malformed route as permission. */
export function approvalRoutes(value: unknown): readonly SourceApprovalRoute[] {
	if (value === undefined) return [];
	return Schema.decodeUnknownSync(Schema.Array(ApprovalRouteSchema))(
		Array.isArray(value) ? value : [value]
	);
}

/** All route team references are exact handles of teams declared in this workspace. */
export function unknownApprovalTeam(
	m: Pick<EngineManifest, 'teams'>,
	route: SourceApprovalRoute
): string | undefined {
	const matches = (match: ApprovalMatchData | undefined): readonly string[] =>
		match === undefined
			? []
			: [
					...(typeof match.requestor === 'object' ? match.requestor.team : []),
					...(match.and ?? []).flatMap(matches),
					...(match.or ?? []).flatMap(matches),
					...matches(match.not)
				];
	return [...route.steps.flat(), ...(route.superseded_by ?? []), ...matches(route.match)].find(
		(handle) => !Object.hasOwn(m.teams, handle)
	);
}
