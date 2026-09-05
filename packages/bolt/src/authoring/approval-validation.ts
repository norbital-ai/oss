import type { PolicyDeclaration, WorkspaceDefinition } from './workspace-schema.js';
import { grantScopeProblems } from '../runtime/access/access-control.js';
import { withSystemCollections } from '../runtime/schema/system-collections.js';

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
	// Accepts authored or already-augmented; idempotent, so no double-augment.
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
	diagnostics.push(
		...grantScopeProblems(merged).map(
			({ message }) => ({ rule: 'grant-scope-unknown-column', message }) as const
		)
	);

	return diagnostics;
};

export const approvalRefusal = (definition: WorkspaceDefinition): string | undefined => {
	const diagnostics = approvalDiagnostics(definition);
	if (diagnostics.length === 0) return undefined;
	return [
		`This workspace declares ${diagnostics.length} authority binding${diagnostics.length === 1 ? '' : 's'} that cannot resolve:`,
		...diagnostics.map(({ message }) => `  - ${message}`)
	].join('\n');
};
