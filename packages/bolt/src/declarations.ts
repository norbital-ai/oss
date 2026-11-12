// Runtime bindings emitted by the compiler. Authored model and integration files import their generated declaration.
export { bind_model } from './decl/model.ts';
export { bind_integration } from './decl/runtime/integration.ts';
export type { Model, ModelDeclaration, ModelLiteral, ModelLiteralInput } from './decl/model.ts';
export type {
	Integration,
	IntegrationDeclaration,
	IntegrationLiteral,
	IntegrationLiteralInput
} from './decl/runtime/integration.ts';
