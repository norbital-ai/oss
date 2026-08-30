import type { PolicyDeclaration, WorkspaceDefinition } from '../authoring/workspace-schema.js';
import { grantScopeProblems } from '../runtime/access/access-control.js';
import { withSystemCollections } from '../runtime/schema/system-collections.js';

/**
 * Authority bindings which the compiler can resolve from one complete workspace definition.
 *
 * There is deliberately no union rule for duplicate coordinates within one effective holder. One
 * concrete grant owns one coordinate for a team, envoy, automation, or integration, so field masks,
 * write authorization, and approval routing have one answer for every subject the runtime can mint.
 * Alternative holders may own the same coordinate with different scopes: that is how, for example,
 * a controller reads every row while a contractor reads only assigned rows. Runtime-owned policies
 * are merged before this check; otherwise an authored grant can collide with the authenticated
 * system read policy in production while the compiler approves an incomplete definition.
 */
type ApprovalDiagnostic = Readonly<{
	readonly rule:
		| 'undeclared-team-policy'
		| 'overlapping-policy-grant'
		| 'approval-without-history'
		| 'grant-scope-unknown-column';
	readonly message: string;
}>;

const fold = (value: string): string => value.trim().toLocaleLowerCase();

type Holder = Readonly<{
	readonly label: string;
	readonly policies: ReadonlyArray<string>;
}>;

const holdersOf = (definition: WorkspaceDefinition): ReadonlyArray<Holder> => [
	...Object.entries(definition.teams ?? {}).map(([name, policies]) => ({
		label: `team "${name}"`,
		policies
	})),
	...definition.envoys.map((envoy) => ({
		label: `envoy "${envoy.name}"`,
		policies: envoy.policies
	})),
	...definition.automations.map((automation) => ({
		label: `automation "${automation.name}"`,
		policies: automation.policies ?? []
	})),
	...(definition.integrations ?? []).map((integration) => ({
		label: `integration "${integration.name}"`,
		policies: integration.policies
	}))
];

/** Refuses every duplicate `(collection, action)` inside one effective holder composition. */
const overlapDiagnostics = (
	holders: ReadonlyArray<Holder>,
	declaredPolicies: ReadonlyMap<string, PolicyDeclaration>
): ReadonlyArray<ApprovalDiagnostic> => {
	const diagnostics: Array<ApprovalDiagnostic> = [];
	const authenticated = [...declaredPolicies]
		.filter(([, declaration]) => declaration.authenticated === true)
		.map(([name]) => name);
	const effectiveHolders = [
		...holders.map((holder) => ({
			...holder,
			policies: [...new Set([...holder.policies.map(fold), ...authenticated])]
		})),
		{
			label: 'runtime system subject',
			policies: [...declaredPolicies]
				.filter(([, declaration]) => declaration.system === true)
				.map(([name]) => name)
		}
	];

	for (const holder of effectiveHolders) {
		const byCoordinate = new Map<string, Array<string>>();
		for (const name of holder.policies) {
			const policy = declaredPolicies.get(fold(name));
			if (policy === undefined) continue;
			for (const grant of policy.grants ?? []) {
				const coordinate = `${grant.collection}:${grant.action}`;
				const owners = byCoordinate.get(coordinate) ?? [];
				owners.push(policy.name);
				byCoordinate.set(coordinate, owners);
			}
		}

		for (const [coordinate, owners] of [...byCoordinate].toSorted(([left], [right]) =>
			left.localeCompare(right)
		)) {
			if (owners.length < 2) continue;
			const [collection, action] = coordinate.split(':');
			const uniqueOwners = [...new Set(owners)].toSorted();
			const source =
				uniqueOwners.length === 1
					? `policy "${uniqueOwners[0]}" declares it more than once`
					: `policies ${uniqueOwners.map((owner) => `"${owner}"`).join(', ')} declare it`;
			diagnostics.push({
				rule: 'overlapping-policy-grant',
				message:
					`${holder.label} composes ${source}: ${action} on ${collection} has more than one grant. ` +
					`Every collection/action coordinate must have exactly one owner per holder; move the shared grant into one policy and compose that policy once.`
			});
		}
	}
	return diagnostics;
};

/**
 * Refuses any approval gate on a collection that keeps no history.
 *
 * History is the approval service's durable review ledger: it identifies every record governed by
 * a request and supplies the masked snapshots compared on resume. The requirement therefore does
 * not depend on the write verb. A create still needs a durable review member, and a held delete
 * still needs the record snapshot its reviewers are deciding about.
 */
const historyDiagnostics = (definition: WorkspaceDefinition): ReadonlyArray<ApprovalDiagnostic> => {
	const withoutHistory = new Set(
		definition.collections
			.filter((collection) => collection.history === false)
			.map((collection) => fold(collection.name))
	);
	if (withoutHistory.size === 0) return [];
	const diagnostics: Array<ApprovalDiagnostic> = [];
	const seen = new Set<string>();
	for (const policy of definition.policies) {
		for (const grant of policy.grants ?? []) {
			if (!('approval' in grant) || grant.approval === undefined) continue;
			if (!withoutHistory.has(fold(grant.collection))) continue;
			const coordinate = `${policy.name}:${grant.collection}:${grant.action}`;
			if (seen.has(coordinate)) continue;
			seen.add(coordinate);
			diagnostics.push({
				rule: 'approval-without-history',
				message: `policy "${policy.name}" gates ${grant.action} on ${grant.collection}, which declares history: false. Approval review membership and masked snapshots are stored in collection history, so this request could not be reviewed or resumed faithfully. Give ${grant.collection} history, or remove its approval gate.`
			});
		}
	}
	return diagnostics;
};

export const approvalDiagnostics = (
	definition: WorkspaceDefinition
): ReadonlyArray<ApprovalDiagnostic> => {
	const diagnostics: Array<ApprovalDiagnostic> = [];
	const merged = withSystemCollections(definition);
	const declaredPolicies = new Map(
		merged.policies.map((policy) => [fold(policy.name), policy] as const)
	);
	const holders = holdersOf(merged);

	for (const holder of holders) {
		for (const policy of holder.policies) {
			if (declaredPolicies.has(fold(policy))) continue;
			diagnostics.push({
				rule: 'undeclared-team-policy',
				message: `${holder.label} names the policy "${policy}", which no policy file declares. The name is dropped at runtime, so it silently holds less than the declaration says.`
			});
		}
	}
	diagnostics.push(...overlapDiagnostics(holders, declaredPolicies));
	diagnostics.push(...historyDiagnostics(merged));
	// The rule belongs to `access-control.ts`, which owns what a grant's row scope may say; it is
	// reported here because this is where a release's authority bindings are refused together, and a
	// scope that cannot resolve is the same kind of fault as a policy name that cannot.
	diagnostics.push(
		...grantScopeProblems(merged).map(
			({ message }) => ({ rule: 'grant-scope-unknown-column', message }) as const
		)
	);

	return diagnostics;
};

/** The diagnostics as one hard refusal, or nothing. */
export const approvalRefusal = (definition: WorkspaceDefinition): string | undefined => {
	const diagnostics = approvalDiagnostics(definition);
	if (diagnostics.length === 0) return undefined;
	return [
		`This workspace declares ${diagnostics.length} authority binding${diagnostics.length === 1 ? '' : 's'} that cannot resolve:`,
		...diagnostics.map(({ message }) => `  - ${message}`)
	].join('\n');
};
