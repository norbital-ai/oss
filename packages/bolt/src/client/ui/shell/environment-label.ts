/**
 * Sidebar badge label for the host's deployment environment, or `undefined` for production.
 *
 * Production renders nothing by design: the badge exists so a non-production host is never
 * mistaken for the real thing. `development` reads as `local`, matching operator language; any
 * other non-empty value renders as itself, so a future environment is fail-visible rather than
 * silently unbadged.
 *
 * Duplicated — not shared — with Colony's `deployEnvironmentLabel`: the compiled tenant bundle
 * cannot import host code, and the host cannot import framework source. The two must agree.
 */
export const workspaceEnvironmentLabel = (
	environment: string | undefined
): string | undefined => {
	if (environment === undefined) return undefined;
	const normalized = environment.trim();
	if (normalized.length === 0 || normalized === 'production') return undefined;
	if (normalized === 'development') return 'local';
	return normalized;
};
