// repository-health:allow SEM_PARALLEL -- finder-entity consumes CommandScope over the #lib alias
// (#lib/client/ui/agent/mention-sources.js), so the pair is linked, not parallel.
import type { CommandItemData } from '@norbital-ai/ui/command';
import type { CommandScope } from '#lib/client/ui/agent/mention-sources.js';

type FinderRowKind = 'group' | 'app' | 'record' | 'command' | 'loading' | 'empty' | 'scope';

export type FinderRow = CommandItemData & {
	kind: FinderRowKind;
	icon?: string | null;
	thumbnail?: string | null;
	depth?: number;
	/**
	 * A short trailing marker — the `#`, `/`, `>`, `!` a prefix row types for you.
	 *
	 * Separate from `description` because the two want opposite treatment: a hint is one glyph that
	 * belongs pinned to the right edge like a shortcut, prose belongs in a left-aligned column wide
	 * enough to read. Sharing one slot made every app description compete with a punctuation mark for
	 * the same 10rem and lose.
	 */
	hint?: string;
	entity?: FinderEntity;
};

/**
 * One thing the finder can hand back. Hosts declare what a pick means — navigate, open a
 * record sheet, or insert prompt text — without the palette knowing about either surface.
 */
export type FinderEntity =
	| {
			readonly kind: 'app';
			readonly key: string;
			readonly label: string;
			readonly href: string;
			readonly description: string | null;
	  }
	| {
			readonly kind: 'record';
			readonly collection: string;
			readonly recordId: string;
			readonly label: string;
	  }
	| {
			readonly kind: 'scope';
			readonly collection: string;
	  }
	| {
			readonly kind: 'collection';
			readonly collection: string;
	  }
	| {
			readonly kind: 'prefix';
			readonly scope: CommandScope;
	  }
	| {
			readonly kind: 'plan';
			readonly query: string;
	  }
	| {
			readonly kind: 'ask-agent';
			readonly query: string;
	  }
	| {
			readonly kind: 'navigate';
			readonly href: string;
	  };

type FinderPromptInsert = {
	readonly text: string;
	readonly mention?: {
		readonly collection: string;
		readonly recordId: string;
		readonly label: string;
	};
};

/** Chip / prose the composer inserts so the model sees path, collection, and label. */
export function formatFinderEntityForPrompt(entity: FinderEntity): FinderPromptInsert | null {
	switch (entity.kind) {
		case 'app': {
			const title = entity.description
				? `${entity.href} — ${entity.label}: ${entity.description}`
				: `${entity.href} — ${entity.label}`;
			return { text: title };
		}
		case 'record': {
			const label = `${entity.collection} › ${entity.label}`;
			return {
				text: `@${label}`,
				mention: {
					collection: entity.collection,
					recordId: entity.recordId,
					label
				}
			};
		}
		case 'collection':
			return { text: `collection:${entity.collection}` };
		case 'scope':
		case 'prefix':
		case 'plan':
		case 'ask-agent':
		case 'navigate':
			return null;
		default: {
			const _exhaustive: never = entity;
			return _exhaustive;
		}
	}
}
