export type FacilityDeclaration = {
	readonly ai?: true;
};

/** Declare host facilities used by deterministic workspace code. */
export function defineFacilities(
	declaration: FacilityDeclaration
): readonly (keyof FacilityDeclaration)[] {
	return declaration.ai ? ['ai'] : [];
}
