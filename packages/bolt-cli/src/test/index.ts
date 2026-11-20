// Public test edge: one scoped workspace layer and Effect-native callers.
export {
	it,
	expect,
	type NativeReadAnswer,
	type NativeActAnswer,
	type Caller,
	KitInvalid,
	type CassetteOptions,
	type TestPorts,
	type TestOptions,
	type Kit,
	type WorkspaceServices,
	JobResult,
	NativeReadRow,
	respond_system_1,
	TestWorkspace
} from './effect.ts';
/** Host port Effect services for supplying test layers in `TestWorkspace.layer({ ports })`. */
export { Ai, Convert, Files, Render, WebRead } from '@norbital-ai/bolt/engine';
/** Host port helpers, database request/result schemas, AI decision/request types, and database error class for fake test ports. */
export {
	DatabaseRequest,
	DbError,
	DecisionResult,
	Port,
	type AiRequest,
	type AiResponse,
	type DatabaseResult,
	type PortFailure
} from '@norbital-ai/host-api';
export { memory_audit } from './audit.ts';
export { release } from './release.ts';
export { prune } from './checkpoint.ts';
// a host's tests generate a fixture's migration history as `bolt build` does
export { prepare_migrations } from '../compiler/migrations.ts';
export { runAutomation, settledRun } from './runs.ts';
