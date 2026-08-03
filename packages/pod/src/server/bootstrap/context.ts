import type { TBaseScope } from '$lib/shared/scope.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import {
	NORBITAL_BASE_SCOPE_HEADER,
	parseHostProvidedBaseScope
} from '$lib/server/bootstrap/host_base_scope.js';
import { getManifestContext } from '$lib/server/bootstrap/manifest_context.js';
import { resolveRequestorBaseScope } from '$lib/server/bootstrap/resolve_workspace.js';
import {
	createWorkspaceContext,
	type ProvisionedContext,
	type UserOrganizationInfo
} from '$lib/server/bootstrap/workspace_store.js';
import type { PodRequestEvent } from '$lib/server/request-context.js';
import { error } from '$lib/server/http.js';
import { typeGuard } from '@norbital-ai/std/schema';
import { safeParse } from '@norbital-ai/std/json';
import { z } from 'zod';
import { UserRoleSchema, UserStatusSchema } from '@norbital-ai/platform-utils/system/types';
import { createTenantDbFromBinding as createCtxDb } from '$lib/server/bootstrap/tenant_db_binding.js';

const NORBITAL_USER_ORGANIZATIONS_HEADER = 'x-norbital-user-organizations';

const userOrganizationInfoSchema = z.object({
	organizationId: z.string(),
	organizationName: z.string(),
	organizationSlug: z.string(),
	logoUrl: z.string().nullable(),
	role: UserRoleSchema,
	userStatus: UserStatusSchema
});

function parseHostProvidedUserOrganizations(
	raw: string | null | undefined
): UserOrganizationInfo[] {
	const trimmed = raw?.trim();
	if (!trimmed) return [];
	const parsed = safeParse(trimmed);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((entry): entry is UserOrganizationInfo =>
		typeGuard(userOrganizationInfoSchema, entry)
	);
}

function hostProvidedBaseScope(event: PodRequestEvent, userId: string): TBaseScope | null {
	return parseHostProvidedBaseScope(event.request.headers.get(NORBITAL_BASE_SCOPE_HEADER), userId);
}

export async function buildCtx(event: PodRequestEvent): Promise<ProvisionedContext | null> {
	const zone = event.locals.zone;
	const userId = event.locals.identity;
	const organization = {
		norbital_id: event.locals.org.id.trim(),
		name: event.locals.org.name.trim()
	};

	if (!organization.norbital_id || !organization.name) {
		throw error(500, 'Organization identity is not configured');
	}

	const tenantDb = createCtxDb(event.locals.db);
	const manifestCtx = getManifestContext(zone, organization.norbital_id);
	const workspace = getTenantWorkspace();
	const tableRegistry = workspace.tables;
	const relationsRegistry = workspace.relations;

	const providedBaseScope = hostProvidedBaseScope(event, userId);
	const hasHostBaseScope = Boolean(event.request.headers.get(NORBITAL_BASE_SCOPE_HEADER)?.trim());

	if (!userId && !hasHostBaseScope) {
		return null;
	}

	if (hasHostBaseScope && !providedBaseScope) {
		throw error(
			401,
			'Host-provided workspace scope is missing or invalid for authenticated request'
		);
	}
	if (
		providedBaseScope &&
		(providedBaseScope.organization.norbital_id !== organization.norbital_id ||
			providedBaseScope.organization.name !== organization.name)
	) {
		throw error(401, 'Host-provided workspace scope does not match the requested organization');
	}

	const resolved = providedBaseScope
		? { baseScope: providedBaseScope }
		: userId
			? await resolveRequestorBaseScope({ tenantDb, organization, userId })
			: null;

	if (!resolved) {
		if (userId) {
			throw error(401, 'Requestor workspace scope could not be resolved');
		}
		return null;
	}

	return createWorkspaceContext({
		provision: 'provisioned',
		manifestCtx,
		organization,
		baseScope: resolved.baseScope,
		userOrganizations: parseHostProvidedUserOrganizations(
			event.request.headers.get(NORBITAL_USER_ORGANIZATIONS_HEADER)
		),
		zone,
		tenantDb,
		tableRegistry,
		relationsRegistry
	});
}
