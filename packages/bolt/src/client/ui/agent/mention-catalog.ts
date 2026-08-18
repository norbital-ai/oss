import type { MentionAppHit } from './mention-sources.js';

let collections: readonly string[] = [];
let apps: readonly MentionAppHit[] = [];

/** Updates the workspace catalog used by finder and @-mention search. */
export function setBoltMentionCatalog(input: {
	readonly collections?: readonly string[];
	readonly apps?: readonly MentionAppHit[];
}): void {
	if (input.collections) collections = [...input.collections];
	if (input.apps) apps = [...input.apps];
}

/** Returns the latest workspace catalog for mention and finder surfaces. */
export function readBoltMentionCatalog(): {
	readonly collections: readonly string[];
	readonly apps: readonly MentionAppHit[];
} {
	return { collections, apps };
}
