/** A SQL identifier; quoting preserves its name rather than treating punctuation as syntax. */
export const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A SQL string under standard-conforming string rules. Values stay bound when the caller has parameters. */
export const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;
