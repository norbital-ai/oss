/**
 * The two augmentation interfaces the authoring surface publishes, on a module both the internal
 * schema files and the generated tenant code can name without re-entering the package entry.
 *
 * Each interface is declared here empty and merged by `WorkspaceAugmentations`-style generated
 * declarations (`declare module '@norbital-ai/bolt/authoring'`), so both the runtime compiler and
 * the schema files read the same merged shape without importing the barrel that re-exports them.
 */
export interface WorkspaceAuthoringTypes {}

export interface WorkspaceTeamAuthoringTypes {}
