// `seed/+seeder.ts`: the bank tree a template's private rows live in. Rows are stored as they load —
// `seed/public/**`, `seed/test/**` and the tree's `rows/**` hold `<model>.json` files that `bolt check` and `bolt seed`
// decode against the models — so a seeder transforms nothing.
import type { AutomationName } from './names.ts';

/** What `seed/+seeder.ts` declares: the seed bank tree its private demo rows load from, if any. */
export type Seeder = {
	/**
	 * The private rows `bolt seed` reads, in memory, from `<bank>/<tree>/rows/**` (`<model>.json[.gz]` files) into one demo
	 * environment; a `file` value names a path relative to `<bank>/<tree>/` unless `seed/public/assets.json` carries
	 * it. Private rows never enter a release, a host's disk or a template checkout.
	 */
	readonly bank?: {
		/** The bank tree's name: its own axis, not the workspace handle. */
		readonly tree: string;
		/** Automations queued once with the rows when they load. */
		readonly start?: readonly AutomationName[];
	};
};

/**
 * `seed/+seeder.ts`'s default export: names the bank tree a template's private rows live in.
 *
 * A template's rows come from three places. Public rows (`seed/public/**`) ship in the release's `base` pack and reach
 * every environment's provision and reset. Test rows (`seed/test/**`) are synthetic fixtures for the template's own
 * `bolt test`, never published. Private rows live in a bank tree and reach one environment only through `bolt seed`.
 * Without a seeder a template has only its public and test rows.
 *
 * `seed/` holds only `+seeder.ts`, `public/` and `test/`: `**\/<model>.json[.gz]` row files (the file name is the
 * model; a directory groups files or names a test scenario) and `assets.json` (`[{ path, sha256, bytes, content_type }]`)
 * with its `assets/**` bytes; anything else is a `seed-layout` diagnostic. Each row carries its `id` and stored fields
 * in wire form (decimals as numbers, numeric text or `{ "$dec" }`; dates, instants and ids as text) and loads as
 * stored. Identity rows are `sys_user` (`team` names a source team handle) and unnamed `sys_integration` instances.
 *
 * `bolt check` loads the seeder (`seed/seeder`) and decodes every public and test row (`seed/decode`). A row value
 * declaring `$schema` is a JSON Schema whose datatypes are checked (`seed/datatype`): a non-string `format` must name
 * one of `DATATYPE_SHAPES` and a property naming one must have exactly its shape.
 *
 * @example
 * export default seeder({ bank: { tree: 'example', start: ['recompute_balances'] } });
 */
export const seeder = (definition: Seeder): Seeder => definition;
