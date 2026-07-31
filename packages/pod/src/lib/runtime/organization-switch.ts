/**
 * Make another organization canonical, then ask Core for a new document.
 *
 * A tenant's browser entry imports that tenant's compiled app modules, collection surfaces and
 * custom renderers. Those modules cannot be converted into another tenant's bundle by clearing
 * client caches or remounting the component tree. Core is the authority that resolves the active
 * organization to one coherent bundle, manifest, identity and database, so every switch crosses
 * that boundary with a document navigation.
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
