import type { CollectionRecordOperations } from '@norbital-ai/std/collection';
import { getContext, hasContext, setContext } from 'svelte';

const RELATIONSHIP_DIRECTORY_CONTEXT = Symbol.for(
	'@norbital-ai/ui/internal-relationship-directory'
);

/** Bolt supplies a safe relationship lookup without widening the authored collection client. */
export function setRelationshipDirectoryContext(directory: CollectionRecordOperations): void {
	setContext(RELATIONSHIP_DIRECTORY_CONTEXT, directory);
}

/** Internal renderer lookup; consumed through `#lib/collection-runtime`, not the public package. */
export function getRelationshipDirectoryContext(): CollectionRecordOperations | undefined {
	return hasContext(RELATIONSHIP_DIRECTORY_CONTEXT)
		? getContext<CollectionRecordOperations>(RELATIONSHIP_DIRECTORY_CONTEXT)
		: undefined;
}
