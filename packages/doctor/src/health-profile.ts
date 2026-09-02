/**
 * Repository-scoped opinions the health tier reads, never product vocabulary of its own.
 *
 * Reachability, service ownership, and duplicate labels are facts about *a* codebase. The
 * language default names only what every TypeScript repository already has. A repository that
 * wants framework entries, injected-service heritage, or extra generic call names declares them
 * under `.norbital/config/doctor/`.
 */
export type HealthProfile = Readonly<{
	/** Files a runtime loads by convention rather than by import. Regular-expression sources. */
	readonly frameworkEntries: ReadonlyArray<string>;
	/** How this codebase spells a service or an injected dependency. Regular-expression sources. */
	readonly serviceHeritage: ReadonlyArray<string>;
	/** Call names too generic to attribute a duplicate to. */
	readonly genericLabels: ReadonlyArray<string>;
}>;

const PROFILE_KEYS = ['frameworkEntries', 'serviceHeritage', 'genericLabels'] as const;

/** Language vocabulary only — no framework or product names. */
export const LANGUAGE_HEALTH_PROFILE: HealthProfile = {
	frameworkEntries: [
		'(?:^|/)(?:index|main|app)\\.[cm]?[jt]sx?$',
		'(?:^|/)[^/]*\\.config\\.[cm]?[jt]s$',
		'(?:^|/)(?:scripts?|bin|cli|tools)/'
	],
	serviceHeritage: [],
	genericLabels: [
		'Array',
		'Date',
		'Error',
		'Map',
		'Number',
		'Object',
		'Set',
		'String',
		'bind',
		'fn',
		'make',
		'of',
		'success',
		't',
		'update'
	]
};

function unique(left: ReadonlyArray<string>, right: ReadonlyArray<string>): ReadonlyArray<string> {
	return [...new Set([...left, ...right])];
}

function profileField(
	key: (typeof PROFILE_KEYS)[number],
	overlay: Partial<HealthProfile>
): ReadonlyArray<string> {
	switch (key) {
		case 'frameworkEntries':
			return overlay.frameworkEntries ?? [];
		case 'serviceHeritage':
			return overlay.serviceHeritage ?? [];
		case 'genericLabels':
			return overlay.genericLabels ?? [];
		default: {
			const exhausted: never = key;
			throw new Error(`norbital-doctor: unknown health profile field ${String(exhausted)}`);
		}
	}
}

/** Reject a config object that names a field the profile does not have. */
export function assertHealthProfileShape(value: object): void {
	for (const key of Object.keys(value)) {
		switch (key) {
			case 'frameworkEntries':
			case 'serviceHeritage':
			case 'genericLabels':
				break;
			default:
				throw new Error(`norbital-doctor: unknown health profile field ${key}`);
		}
	}
}

function compilePattern(source: string): RegExp {
	const compiled = (() => {
		try {
			return new RegExp(source);
		} catch (error) {
			throw new Error(
				`norbital-doctor: invalid health profile pattern ${JSON.stringify(source)}: ${String(error)}`
			);
		}
	})();
	return compiled;
}

/** Compile every pattern once; a bad source fails at load time, not mid-scan. */
export function compileHealthProfile(profile: HealthProfile): CompiledHealthProfile {
	return {
		frameworkEntries: profile.frameworkEntries.map(compilePattern),
		serviceHeritage: profile.serviceHeritage.map(compilePattern),
		genericLabels: profile.genericLabels
	};
}

export type CompiledHealthProfile = Readonly<{
	readonly frameworkEntries: ReadonlyArray<RegExp>;
	readonly serviceHeritage: ReadonlyArray<RegExp>;
	readonly genericLabels: ReadonlyArray<string>;
}>;

/** Language default plus repository additions. Arrays concatenate and dedupe, in that order. */
export function mergeHealthProfile(
	base: HealthProfile,
	overlay?: Partial<HealthProfile>
): HealthProfile {
	if (overlay === undefined) return base;
	assertHealthProfileShape(overlay);
	const merged: HealthProfile = {
		frameworkEntries: unique(base.frameworkEntries, profileField('frameworkEntries', overlay)),
		serviceHeritage: unique(base.serviceHeritage, profileField('serviceHeritage', overlay)),
		genericLabels: unique(base.genericLabels, profileField('genericLabels', overlay))
	};
	compileHealthProfile(merged);
	return merged;
}

/** Whether any compiled pattern matches the text. */
export function matchesAny(text: string, patterns: ReadonlyArray<RegExp>): boolean {
	return patterns.some((pattern) => pattern.test(text));
}
