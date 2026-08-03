export type CertificationLink = {
	readonly certification_type_id: string;
};

export function contractorSatisfiesCertificationRequirements(
	held: readonly CertificationLink[],
	required: readonly CertificationLink[]
): boolean {
	if (required.length === 0) return true;
	const heldIds = new Set(held.map((link) => link.certification_type_id));
	return required.every((link) => heldIds.has(link.certification_type_id));
}

export function missingCertificationIds(
	held: readonly CertificationLink[],
	required: readonly CertificationLink[]
): string[] {
	const heldIds = new Set(held.map((link) => link.certification_type_id));
	return required
		.map((link) => link.certification_type_id)
		.filter((certificationId) => !heldIds.has(certificationId));
}
