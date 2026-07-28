/**
 * Reckon — Declarative Auditable Computation Engine
 *
 * A computation definition is a named-expr graph of CEL expressions with
 * inlined rate tables. The runtime topo-sorts by AST-extracted dependencies,
 * evaluates in order, and emits a structured replayable manifest per output.
 */

/** A single row in a flat table (key-value lookup). */
type FlatTableRow = Record<string, unknown>;

/** A single row in a tier table (find the bracket where value <= max). */
type TierTableRow = { max: number; [column: string]: number };

/** A single row in a progressive tax table. */
type ProgressiveTableRow = { max: number; rate: number; base?: number };

/** A dimension in a matrix table (multi-dimensional lookup). */
type MatrixDimension = { name: string; kind: 'tier' | 'exact' };

/**
 * Rate tables inlined directly into the computation definition.
 * The definition hash covers exprs + tables, so old results always
 * reference the exact table that was used.
 */
export type InlinedTable =
	| { kind: 'flat'; rows: FlatTableRow[] }
	| { kind: 'tier'; rows: TierTableRow[] }
	| { kind: 'progressive'; rows: ProgressiveTableRow[] }
	| { kind: 'matrix'; dimensions: MatrixDimension[]; rows: FlatTableRow[] };

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
export type ComputationDefinition = {
	/** Unique identifier for this definition. */
	id: string;
	/** Inlined rate/classification tables, keyed by name. Referenced in exprs via string literals. */
	tables: Record<string, InlinedTable>;
	/** Named CEL expressions. Each expr can reference inputs, other exprs, and registered ops. */
	exprs: Record<string, string>;
	/** Which expr names are exposed as outputs. */
	outputs: string[];
	/** Optional mapping from output expr ids to payslip component metadata. */
	components?: Record<string, ComputationComponent>;
	/** Other computation definition ids whose outputs feed into this one's inputs. */
	dependsOn?: string[];
};

export type ComputationComponent = {
	code: string;
	name: string;
	category: 'earning' | 'deduction' | 'employer_cost' | 'info';
};

/** Rounding modes for the `round` op. */
export type RoundingMethod =
	'NONE' | 'NEAREST_CENT' | 'NEAREST_5_CENTS' | 'TRUNCATE_CENT' | 'UP_5_CENTS';

/** A single node in the computation manifest — one per named expr. */
export type ComputationManifestNode = {
	/** The expr name. */
	id: string;
	/** The CEL source string. */
	expr: string;
	/** Values of referenced identifiers at evaluation time. */
	inputs: Record<string, unknown>;
	/** The computed result (scalar or list). */
	output: unknown;
	/** Structured audit from registered ops (e.g. matched tier, rounding before/after). */
	opAudit?: unknown;
	/** Per-iteration traces for `fold` nodes. Collapsed by default in viewers. */
	iterations?: { input: unknown; output: unknown }[];
};

/** Structured, replayable record of a computation run. */
export type ComputationManifest = {
	/** The computation definition id. */
	computationId: string;
	/** SHA-256 hash of the canonicalized definition (exprs + inlined tables). */
	definitionHash: string;
	/** Snapshot of input values — enables replay without live source records. */
	inputSnapshot: Record<string, unknown>;
	/** One node per named expr, in evaluation order. */
	nodes: ComputationManifestNode[];
	/** The declared outputs with their values and source node ids. */
	outputs: Record<string, { value: unknown; nodeId: string }>;
};

/** Result of running a computation — typed outputs + full manifest. */
export type ReckonResult<TOutput = Record<string, unknown>> = {
	/** The declared outputs, typed by the caller via `<TOutput>`. */
	outputs: TOutput;
	/** Full structured manifest for audit and replay. */
	manifest: ComputationManifest;
};

/** Validation error for a computation definition. */
export type ValidationError = {
	expr?: string;
	message: string;
};

/** Result of validating a computation definition. */
export type ValidationResult =
	{ ok: true; definitionHash: string; order: string[] } | { ok: false; errors: ValidationError[] };
