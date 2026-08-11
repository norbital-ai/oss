/**
 * Make another organization canonical, then ask Core for a new document.
 *
 * A tenant's browser entry imports that tenant's compiled app modules, collection surfaces and
 * custom renderers. Those modules cannot be converted into another tenant's bundle by clearing
 * client caches or remounting the component tree. Core is the authority that resolves the active
 * organization to one coherent bundle, manifest, identity and database, so every switch crosses
 * that boundary with a document navigation.
 */
/**
 * Throws if the switch is refused, so the caller can keep rendering the organization it still has.
 *
 * The caller owns the "switching" flag rather than this module: the request has to reach Core, Core
 * has to issue the target session, and only then does the document navigate. For that whole window
 * the previous organization's records are still mounted, and a translucent overlay leaves them
 * legible under the new organization's name — so the shell must evict them, not cover them. Keeping
 * the flag in the component also keeps this module plain TypeScript, which is what lets the switch
 * contract be tested outside a Svelte runtime.
 */
export async function switchOrganization(organizationId: string): Promise<void> {
	const response = await fetch('/api/organizations/switch', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ organizationId })
	});
	if (!response.ok) throw new Error('Unable to switch workspace');

	// Replace rather than push: Back must not resurrect a route from the organization just left.
	window.location.replace('/');
}
