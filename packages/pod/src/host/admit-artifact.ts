/**
 * Artifact the host binds to one admit. Guest persist paths must stamp this, never a dummy id.
 */
import { z } from 'zod';

export const ADMIT_ARTIFACT_HEADER = 'x-norbital-artifact-json';

export const admitArtifactSchema = z.object({
	artifactId: z.string().min(1).max(512),
	checkpointId: z.string().min(1).max(512),
	treeHash: z.string().min(1).max(512),
	runtimeVersion: z.string().min(1).max(512)
});

export type AdmitArtifact = z.infer<typeof admitArtifactSchema>;

export function parseAdmitArtifact(value: unknown): AdmitArtifact | null {
	if (typeof value === 'string') {
		try {
			return parseAdmitArtifact(JSON.parse(value) as unknown);
		} catch {
			return null;
		}
	}
	const parsed = admitArtifactSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function serializeAdmitArtifact(artifact: AdmitArtifact): string {
	return JSON.stringify(admitArtifactSchema.parse(artifact));
}

/** Attach the host's admit artifact to guest kinds that persist a receipt. */
export function withAdmitArtifact(command: unknown, artifact: AdmitArtifact): unknown {
	if (command == null || typeof command !== 'object') return command;
	const kind = 'kind' in command ? command.kind : null;
	const action = 'action' in command ? command.action : null;
	if (kind === 'agent' && action === 'start') return { ...command, artifact };
	if (kind === 'channel') return { ...command, artifact };
	return command;
}
