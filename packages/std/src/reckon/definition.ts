/**
 * Reckon — Declarative Auditable Computation Engine
 *
 * A computation definition is a named-expr graph of CEL expressions with
 * inlined rate tables. The runtime topo-sorts by AST-extracted dependencies,
 * evaluates in order, and emits a structured replayable manifest per output.
 */
import { Schema } from 'effect';

/** A single row in a flat table (key-value lookup). */
const FlatTableRowSchema = Schema.Record(Schema.String, Schema.Unknown);
type FlatTableRow = Schema.Schema.Type<typeof FlatTableRowSchema>;

/** A single row in a tier table (find the bracket where value <= max). */
const TierTableRowSchema = Schema.StructWithRest(Schema.Struct({ max: Schema.Number }), [
	Schema.Record(Schema.String, Schema.Number)
]);
type TierTableRow = Schema.Schema.Type<typeof TierTableRowSchema>;

/** A single row in a progressive tax table. */
const ProgressiveTableRowSchema = Schema.Struct({
	max: Schema.Number,
	rate: Schema.Number,
	base: Schema.optional(Schema.Number)
});
type ProgressiveTableRow = Schema.Schema.Type<typeof ProgressiveTableRowSchema>;

/** A dimension in a matrix table (multi-dimensional lookup). */
const MatrixDimensionSchema = Schema.Struct({
	name: Schema.String,
	kind: Schema.Literals(['tier', 'exact'])
});
type MatrixDimension = Schema.Schema.Type<typeof MatrixDimensionSchema>;

/**
 * Rate tables inlined directly into the computation definition.
 * The definition hash covers exprs + tables, so old results always
 * reference the exact table that was used.
 */
export const InlinedTableSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('flat'), rows: Schema.Array(FlatTableRowSchema) }),
	Schema.Struct({ kind: Schema.Literal('tier'), rows: Schema.Array(TierTableRowSchema) }),
	Schema.Struct({
		kind: Schema.Literal('progressive'),
		rows: Schema.Array(ProgressiveTableRowSchema)
	}),
	Schema.Struct({
		kind: Schema.Literal('matrix'),
		dimensions: Schema.Array(MatrixDimensionSchema),
		rows: Schema.Array(FlatTableRowSchema)
	})
]);
export type InlinedTable = Schema.Schema.Type<typeof InlinedTableSchema>;

const ComputationComponentSchema = Schema.Struct({
	code: Schema.String,
	name: Schema.String,
	category: Schema.Literals(['earning', 'deduction', 'employer_cost', 'info'])
});
type ComputationComponent = Schema.Schema.Type<typeof ComputationComponentSchema>;

/**
 * A declarative computation graph.
 *
 * No input schema is declared — the caller passes any object and optionally
 * types it via the generic `<TInput>` on `runComputation`. The engine
 * resolves expr dependencies by walking CEL ASTs, topo-sorts, and evaluates.
 *
 * @example
 * ```ts
 * const def: ComputationDefinition = {
 *   id: 'my-pcb-2026',
 *   tables: {
 *     pcbTable: {
 *       kind: 'progressive',
 *       rows: [
 *         { max: 5000, rate: 0.0, base: 0 },
 *         { max: 20000, rate: 0.01, base: 0 },
 *       ],
 *     },
 *   },
 *   exprs: {
 *     annualized: 'taxableEarnings * 12',
 *     pcb: 'round(applyProgressive(annualized, "pcbTable") / 12, "NEAREST_CENT")',
 *   },
 *   outputs: ['pcb'],
 * };
 * ```
 */
export const ComputationDefinitionSchema = Schema.Struct({
	/** Unique identifier for this definition. */
	id: Schema.String,
	/** Inlined rate/classification tables, keyed by name. Referenced in exprs via string literals. */
	tables: Schema.Record(Schema.String, InlinedTableSchema),
	/** Named CEL expressions. Each expr can reference inputs, other exprs, and registered ops. */
	exprs: Schema.Record(Schema.String, Schema.String),
	/** Which expr names are exposed as outputs. */
	outputs: Schema.Array(Schema.String),
	/** Optional mapping from output expr ids to payslip component metadata. */
	components: Schema.optional(Schema.Record(Schema.String, ComputationComponentSchema)),
	/** Other computation definition ids whose outputs feed into this one's inputs. */
	dependsOn: Schema.optional(Schema.Array(Schema.String))
});
export type ComputationDefinition = Schema.Schema.Type<typeof ComputationDefinitionSchema>;

/** Rounding modes for the `round` op. */
export const RoundingMethodSchema = Schema.Literals([
	'NONE',
	'NEAREST_CENT',
	'NEAREST_5_CENTS',
	'TRUNCATE_CENT',
	'UP_5_CENTS'
]);
export type RoundingMethod = Schema.Schema.Type<typeof RoundingMethodSchema>;

/** A single node in the computation manifest — one per named expr. */
export const ComputationManifestNodeSchema = Schema.Struct({
	/** The expr name. */
	id: Schema.String,
	/** The CEL source string. */
	expr: Schema.String,
	/** Values of referenced identifiers at evaluation time. */
	inputs: Schema.Record(Schema.String, Schema.Unknown),
	/** The computed result (scalar or list). */
	output: Schema.Unknown,
	/** Structured audit from registered ops (e.g. matched tier, rounding before/after). */
	opAudit: Schema.optional(Schema.Unknown),
	/** Per-iteration traces for `fold` nodes. Collapsed by default in viewers. */
	iterations: Schema.optional(
		Schema.Array(
			Schema.Struct({
				input: Schema.Unknown,
				output: Schema.Unknown
			})
		)
	)
});
export type ComputationManifestNode = Schema.Schema.Type<typeof ComputationManifestNodeSchema>;

/** Structured, replayable record of a computation run. */
export const ComputationManifestSchema = Schema.Struct({
	/** The computation definition id. */
	computationId: Schema.String,
	/** SHA-256 hash of the canonicalized definition (exprs + inlined tables). */
	definitionHash: Schema.String,
	/** Snapshot of input values — enables replay without live source records. */
	inputSnapshot: Schema.Record(Schema.String, Schema.Unknown),
	/** One node per named expr, in evaluation order. */
	nodes: Schema.Array(ComputationManifestNodeSchema),
	/** The declared outputs with their values and source node ids. */
	outputs: Schema.Record(
		Schema.String,
		Schema.Struct({ value: Schema.Unknown, nodeId: Schema.String })
	)
});
export type ComputationManifest = Schema.Schema.Type<typeof ComputationManifestSchema>;

/**
 * Result of running a computation — typed outputs + full manifest.
 *
 * `TOutput` is a caller-chosen generic: the engine has no input or output schema by design, so the
 * declared outputs keep their caller-provided type and the manifest is the schema-owned part.
 * The engine only ever yields a plain string-keyed object of unknown values, so the bound to
 * `Record<string, unknown>` states that contract; the caller's key claims are still theirs to
 * uphold.
 */
export type ReckonResult<TOutput extends Record<string, unknown> = Record<string, unknown>> = {
	/** The declared outputs, typed by the caller via `<TOutput>`. */
	outputs: TOutput;
	/** Full structured manifest for audit and replay. */
	manifest: ComputationManifest;
};

/** Validation error for a computation definition. */
export const ValidationErrorSchema = Schema.Struct({
	expr: Schema.optional(Schema.String),
	message: Schema.String
});
export type ValidationError = Schema.Schema.Type<typeof ValidationErrorSchema>;

/** Result of validating a computation definition. */
export const ValidationResultSchema = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		definitionHash: Schema.String,
		order: Schema.Array(Schema.String)
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		errors: Schema.Array(ValidationErrorSchema)
	})
]);
export type ValidationResult = Schema.Schema.Type<typeof ValidationResultSchema>;
