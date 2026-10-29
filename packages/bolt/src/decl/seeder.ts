// `seed/+seeder.ts` (docs/seeding.md): the bank tree a template's private rows live in. Rows are stored as they load —
// `seed/public/**`, `seed/test/**` and the tree's `rows/**` hold `<model>.json` files that `bolt check` and `bolt seed`
// decode against the models — so a seeder transforms nothing.
import type { AutomationName } from './names.ts';

/** What `seed/+seeder.ts` declares: the seed bank tree its private demo rows load from, if any. */
export type Seeder = {
	/** The private rows `bolt seed` reads, in memory, from `<bank>/<tree>/rows/**` into one demo environment. */
	readonly bank?: {
		readonly tree: string;
		/** Automations queued once with the rows when they load. */
		readonly start?: readonly AutomationName[];
	};
};

/** `seed/+seeder.ts`'s default export. */
export const seeder = (definition: Seeder): Seeder => definition;
