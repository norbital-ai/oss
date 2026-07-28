import type { ManifestCollectionEntry } from '@norbital-ai/platform-utils/manifest/types';
import type {
	TApprovalConfig,
	TApprovalConfigStepNode,
	TApprovalRequest,
	TApprovalRequestStepNode,
	TChatSession,
	TMutationActionKey,
	TPolicy
} from '@norbital-ai/platform-utils/system/types';
import {
	BreadcrumbItemSchema,
	ContextNavStackItemSchema,
	type TBaseScope,
	type TNorbitalDBRecord,
	type TScopeOrganization,
	type TScopeRequestor,
	type TUserInfo
} from '$lib/shared/scope.js';
import { z } from 'zod';

export type {
	TApprovalConfig,
	TApprovalConfigStepNode,
	TApprovalRequest,
	TApprovalRequestStepNode,
	TChatSession,
	TMutationActionKey
};
export type { TBaseScope, TNorbitalDBRecord, TScopeOrganization, TScopeRequestor, TUserInfo };

export const ViewModeSchema = z.enum(['page', 'sidesheet']);
const stackItemExpandSchema = z.object({}).passthrough();
export const NavStackItemSchema = z.object({
	collection_name: z.string(),
	record_id: z.string(),
	node_id: z.string(),
	viewMode: ViewModeSchema,
	with: stackItemExpandSchema.optional()
});

export { ContextNavStackItemSchema, BreadcrumbItemSchema };

type TNavStateShape = {
	stack: Array<z.infer<typeof NavStackItemSchema>>;
};

const _NorbitalDBRecordZod = z.record(z.string(), z.unknown());

export const DynamicApplicationContextResolvedSchema = z.object({
	selected_record: _NorbitalDBRecordZod.nullable(),
	bread_crumbs: z.array(BreadcrumbItemSchema)
});

const _BaseNavStateZod = z.object({
	stack: z.array(NavStackItemSchema)
});

export const SYSTEM_NAV_NODE_IDS = {
	APPROVAL: 'host:system:approval',
	WORKSPACE_RECORD: 'host:system:workspace-record'
} as const;

function validateNavStateSemantics(nav: TNavStateShape): void {
	if (nav.stack.length === 0) {
		throw new Error('Navigation stack must contain at least one item.');
	}
}

export const NavStateSchema = _BaseNavStateZod.superRefine((data, ctx) => {
	try {
		validateNavStateSemantics(data);
	} catch (err) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: err instanceof Error ? err.message : 'Invalid nav state'
		});
	}
});

export type { TBreadcrumbItem, ContextNavStackItem } from '$lib/shared/scope.js';
export type ViewMode = z.infer<typeof ViewModeSchema>;
export type NavStackItem = z.infer<typeof NavStackItemSchema>;
export type NavState = z.infer<typeof NavStateSchema>;
export type TDynamicApplicationContextResolvedState = z.infer<
	typeof DynamicApplicationContextResolvedSchema
>;

export type TDynamicApplicationScopeData = TBaseScope & TDynamicApplicationContextResolvedState;

export type TCollectionMutationPayload = Record<string, unknown>;

export type TCollectionActionContext =
	| {
			type: 'list';
			scope: TBaseScope & { records: null };
			collectionMetadata?: ManifestCollectionEntry;
	  }
	| {
			type: 'view';
			scope: TBaseScope & { records: null };
			collectionMetadata?: ManifestCollectionEntry;
	  }
	| {
			type: 'create';
			payload: TCollectionMutationPayload;
			scope: TBaseScope & { incoming_record: TCollectionMutationPayload };
			collectionMetadata?: ManifestCollectionEntry;
	  }
	| {
			type: 'update';
			payload: TCollectionMutationPayload;
			scope: TBaseScope & {
				incoming_record: TCollectionMutationPayload;
				original_record: TNorbitalDBRecord;
			};
			collectionMetadata?: ManifestCollectionEntry;
	  }
	| {
			type: 'delete';
			scope: TBaseScope & { original_record: TNorbitalDBRecord };
			collectionMetadata?: ManifestCollectionEntry;
	  };

export type TResolvedApprovalConfig = TApprovalConfig & {
	collection_name: string;
};

export type PermissionEvaluationResult = {
	hasDirectAccess: boolean;
	reducedCondition: TPolicy['grants'][number]['conditions'] | null;
	approvalConfig: TResolvedApprovalConfig | null;
};

export type TCollectionPermissionScopeInput = {
	approvalServiceBypassKey?: string;
	approvalRequestId?: string;
	collectionMetadata: ManifestCollectionEntry;
	context: TCollectionActionContext;
};

export type TCollectionPermissionScopeOutput = TCollectionPermissionScopeInput & {
	policyGrants: Array<TPolicy['grants'][number]>;
	approvalConfig?: TResolvedApprovalConfig | null;
	reducedCondition?: TPolicy['grants'][number]['conditions'];
};

export function parseDynamicApplicationContextResolvedState(
	value: unknown
): TDynamicApplicationContextResolvedState {
	return DynamicApplicationContextResolvedSchema.parse(value);
}

export function isSameNavStackItem(a: NavStackItem, b: NavStackItem): boolean {
	return (
		a.collection_name === b.collection_name &&
		a.record_id === b.record_id &&
		a.node_id === b.node_id
	);
}
