export {
	processApprovalRequestAction,
	withdrawApprovalRequest
} from './approval_request/approval_request.remote.js';
export {
	adminCreateSystemRecord,
	adminDeleteSystemRecord,
	adminUpdateSystemRecord,
	count,
	create,
	createMany,
	deleteRecord,
	exportPipeline,
	findGrouped,
	findHistory,
	findFirst,
	findMany,
	getCollectionDefinitions,
	importPipeline,
	update,
	updateMany
} from './collection.remote.js';
export {
	agentChat,
	agentChatStart,
	agentModels,
	AgentChatInputSchema,
	AgentModelsInputSchema,
	type AgentChatResult,
	type AgentChatStartResult
} from './agent_chat.remote.js';
export { autocompleteGeolocation } from './geolocation.remote.js';

export {
	NoArgRemoteInputSchema,
	applyRemoteMiddleware,
	isNonSchemaFunction,
	type MaybePromise,
	type Middleware,
	type RemoteLiveGeneratorReturn,
	type RemoteMiddleware,
	type RemoteSchemaInput,
	type RemoteSchemaOutput
} from '@norbital-ai/platform-utils/remote';
export { idInputSchema, noInputSchema, pathInputSchema } from '@norbital-ai/platform-utils/remote';
