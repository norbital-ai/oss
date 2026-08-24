import type { PolicyDeclaration, WorkspaceDefinition } from '../authoring/workspace-schema.js';

/**
 * Authority bindings which the compiler can resolve from one complete workspace definition.
 *
 * A policy file cannot repeat a collection/action coordinate because authored grants are an object
 * map. Composition is the remaining place a duplicate can enter: a team, envoy, or automation may
 * name more than one policy. There is deliberately no union rule for duplicate coordinates. One
 * concrete grant owns one coordinate, so field masks, write authorization, and approval routing all
 * have one answer.
 */
type ApprovalDiagnostic = Readonly<{
	readonly rule: 'undeclared-team-policy' | 'overlapping-policy-grant';
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

/** Refuses every duplicate `(collection, action)` reached through one holder. */
const overlapDiagnostics = (
	holder: Holder,
	declaredPolicies: ReadonlyMap<string, PolicyDeclaration>
): ReadonlyArray<ApprovalDiagnostic> => {
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

	const diagnostics: Array<ApprovalDiagnostic> = [];
	for (const [coordinate, owners] of [...byCoordinate].toSorted(([left], [right]) =>
		left.localeCompare(right)
	)) {
		if (owners.length < 2) continue;
		const [collection, action] = coordinate.split(':');
		const uniqueOwners = [...new Set(owners)].toSorted();
		const source =
			uniqueOwners.length === 1
				? `policy "${uniqueOwners[0]}" declares it more than once`
				: `${holder.label} receives it from ${uniqueOwners.map((owner) => `"${owner}"`).join(', ')}`;
		diagnostics.push({
			rule: 'overlapping-policy-grant',
			message:
				`${source}: ${action} on ${collection} has more than one grant. ` +
				`Every collection/action coordinate must have exactly one owner; move the shared grant into one policy and compose that policy once.`
		});
	}
	return diagnostics;
};

export const approvalDiagnostics = (
	definition: WorkspaceDefinition
): ReadonlyArray<ApprovalDiagnostic> => {
	const diagnostics: Array<ApprovalDiagnostic> = [];
	const declaredPolicies = new Map(
		definition.policies.map((policy) => [fold(policy.name), policy] as const)
	);

	for (const holder of holdersOf(definition)) {
		for (const policy of holder.policies) {
			if (declaredPolicies.has(fold(policy))) continue;
			diagnostics.push({
				rule: 'undeclared-team-policy',
				message: `${holder.label} names the policy "${policy}", which no policy file declares. The name is dropped at runtime, so it silently holds less than the declaration says.`
			});
		}
		diagnostics.push(...overlapDiagnostics(holder, declaredPolicies));
	}

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
