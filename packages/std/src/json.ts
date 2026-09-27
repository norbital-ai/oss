// std/json (§3.7, L-BOLT-956).

/** The parsed value, or null for invalid JSON (never a throw). */
export function parseJson(text: string): unknown {
	try { return JSON.parse(text); } catch { return null; }
}
