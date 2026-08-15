/**
 * Resolve the artifact this admit must stamp on a receipt. Fail closed — never write a dummy id.
 */
import {
	ADMIT_ARTIFACT_HEADER,
	admitArtifactSchema,
	parseAdmitArtifact,
	type AdmitArtifact
} from '$lib/host/admit-artifact.js';
import { currentPodCallOrNull } from '$lib/server/pod-call.js';

export type { AdmitArtifact };
export { ADMIT_ARTIFACT_HEADER, admitArtifactSchema, parseAdmitArtifact };

export function requireAdmitArtifact(explicit?: AdmitArtifact | null): AdmitArtifact {
	const header = currentPodCallOrNull()?.event.request.headers.get(ADMIT_ARTIFACT_HEADER);
	const fromHeader = parseAdmitArtifact(header);
	if (fromHeader) return fromHeader;
	if (explicit) return admitArtifactSchema.parse(explicit);
	throw new Error('Automation admission requires an artifact binding');
}
