import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { Schema } from 'effect';

const SCOPED = new Set([
	'EFF1',
	'EFF2',
	'EFF3',
	'EFF6',
	'EFF7',
	'EFF8',
	'EFF9',
	'EFF10',
	'EFF11',
	'EFF12',
	'EFF13',
	'EFF14',
	'EFF15',
	'EFF16',
	'ERASE1',
	'ERASE2',
	'ERASE3'
]);
export const scopedEffectRule = (id: string): boolean => SCOPED.has(id);
/** An empty ratchet explicitly enables no end-state rules. A nested repository inherits the realm list. */
export function effectScope(root: string, file: string): boolean {
	let directory = root;
	for (;;) {
		const config = join(directory, '.norbital-doctor-effect-scope.json');
		if (existsSync(config)) {
			const scopes = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
				readFileSync(config, 'utf8')
			);
			const relative = posix.join(root.slice(directory.length).replace(/^\//, ''), file);
			return scopes.some(
				(scope) =>
					posix.matchesGlob(relative, scope) ||
					relative === scope ||
					relative.startsWith(`${scope.replace(/\/$/, '')}/`)
			);
		}
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}

/** Private process entries are configured by the realm, leaving published packages host-independent. */
export function runtimeEdgeAllowed(root: string, file: string): boolean {
	let directory = root;
	for (;;) {
		const config = join(directory, '.norbital-doctor-effect-edges.json');
		if (existsSync(config)) {
			const edges = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
				readFileSync(config, 'utf8')
			);
			const relative = posix.join(root.slice(directory.length).replace(/^\//, ''), file);
			return edges.some((edge) => posix.matchesGlob(relative, edge));
		}
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}
