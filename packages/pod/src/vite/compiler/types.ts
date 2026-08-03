import type { SkillFile } from '$lib/skills/types.js';

export interface SourcePosition {
	readonly line: number;
	readonly column: number;
}

export interface StructuralDiagnostic {
	readonly source: 'pod';
	readonly severity: 'error';
	readonly code: string;
	readonly file: string;
	readonly start: SourcePosition;
	readonly message: string;
}

export interface CollectionRoles {
	readonly model: string;
	readonly hooks?: string;
	readonly pipelines?: string;
	readonly integrations?: string;
	readonly representation?: string;
}

export interface DiscoveredCollection {
	readonly id: string;
	readonly path: string;
	readonly roles: CollectionRoles;
}

export interface DiscoveredCustomType {
	readonly id: string;
	readonly path: string;
	readonly definition: string;
	readonly renderer: string;
}

export interface AppMetadata {
	readonly title: string;
	readonly description: string | null;
	readonly icon: string;
	readonly thumbnail: string | null;
	readonly banner: string | null;
}

export interface DiscoveredApp {
	readonly id: string;
	readonly kind: 'app';
	readonly path: string;
	readonly parentId: string | null;
	readonly source: string;
	readonly metadata: AppMetadata;
}

export interface DiscoveredGroup {
	readonly id: string;
	readonly kind: 'group';
	readonly path: string;
	readonly parentId: string | null;
	readonly source: string;
}

export type DiscoveredAppNode = DiscoveredApp | DiscoveredGroup;

export interface DiscoveredWorkspaceRole {
	readonly id: string;
	readonly path: string;
	readonly source: string;
}

/**
 * A skill authored under `src/skills/<name>/`, carried whole rather than by reference.
 *
 * Every other discovered role is a path the generated workspace imports. A skill is markdown, so
 * there is nothing to import — the text has to travel in the structure and be inlined at codegen,
 * which is also why `files` is the full content of the directory and not a listing of it.
 */
export interface DiscoveredSkill {
	readonly name: string;
	/** `src/skills/<name>/SKILL.md` — the file a diagnostic points at. */
	readonly source: string;
	readonly description: string;
	readonly license?: string;
	readonly compatibility?: string;
	readonly metadata?: Readonly<Record<string, string>>;
	/** `SKILL.md` with its frontmatter removed. */
	readonly body: string;
	readonly files: readonly SkillFile[];
}

export interface PodStructure {
	readonly version: 1;
	readonly relationships: string | null;
	readonly collections: readonly DiscoveredCollection[];
	readonly customTypes: readonly DiscoveredCustomType[];
	readonly apps: readonly DiscoveredAppNode[];
	readonly automations: readonly DiscoveredWorkspaceRole[];
	/** `src/+agent.ts`, if declared — the Pod-owned interactive agent profile. */
	readonly agent: string | null;
	readonly remotes: readonly DiscoveredWorkspaceRole[];
	readonly agentTools: readonly DiscoveredWorkspaceRole[];
	readonly policies: readonly DiscoveredWorkspaceRole[];
	readonly channels: readonly DiscoveredWorkspaceRole[];
	readonly skills: readonly DiscoveredSkill[];
	readonly seed: string | null;
	/** `src/+env.ts`, if declared — the public and private names this workspace asks its host for. */
	readonly env: string | null;
	readonly diagnostics: readonly StructuralDiagnostic[];
}

export interface DiagnosticSnapshot {
	readonly version: 1;
	readonly revision: number;
	readonly mode: 'authoring' | 'build';
	readonly status: 'complete';
	readonly summary: {
		readonly files: number;
		readonly errors: number;
		readonly warnings: 0;
	};
	readonly diagnostics: readonly StructuralDiagnostic[];
}

export interface PodFilesystemCompilation {
	readonly valid: boolean;
	readonly structure: PodStructure;
	readonly diagnostics: readonly StructuralDiagnostic[];
	readonly written: readonly string[];
	readonly removed: readonly string[];
}

export interface PodFilesystemCompilerOptions {
	readonly root: string;
	readonly mode?: 'authoring' | 'build';
	readonly revision?: number;
}
