# The rule algebra

Every pack rule is a YAML file. That is the authoring surface — the same dialect a repository
adds under `.norbital/config/doctor/`. The algebra is a port of ast-grep's `SerializableRule`
(`crates/config/src/rule/mod.rs`), so a rule written for ast-grep translates construct for
construct.

```yaml
# packs/boundaries/R3e.yaml
id: R3e
summary: single cast to unknown
severity: error
principles: [simplicity, type-safety]
rule:
  all:
    - pattern: $VALUE as unknown
    - not:
        inside:
          kind: AsExpression
        stopBy:
          kind: AsExpression
examples:
  bad: ['const o = v as unknown;']
  good: ['const n = t as unknown as number;']
```

`rule` is the matcher. A document accepts exactly `id`, `summary`, `severity`, `principles`,
`confidence`, `files`, `ignore`, `dominates`, `rule`, `utils`, `constraints` and `examples`
(`src/patterns-yaml.ts`); any other key is a load error naming the file. `examples` is mandatory
and every `bad` and `good` example is executed by `tests/examples-execute.test.ts`, so a rule that
cannot find its own bad example does not load. Overlap detectors are ordinary documents under
`packs/overlaps/`; there is no `detect`/`prefer` form. A duplicate `id` across packs is a load
error, never a silent shadow. TypeScript does not declare a second copy of the pack.

`defineRule` compiles that document for the runner. It is not how a pack rule is written.

There used to be three functions here — `definePattern`, `defineMatcher` and a separate
`defineRule` — which meant three places to look up how matching works and three subtly different
ways to say the same thing. `definePattern`'s `patterns: [a, b]` is now `rule: { any: [a, b] }` and
its `not: [c]` is `rule: { all: [<shape>, { not: c }] }`, both of which say what they mean.

## Constructs

| Construct                                        | Meaning                                                         |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `'$A + $B'` or `{ pattern }`                     | a shape; `$NAME` binds one node, `$...NAME` a run               |
| `{ pattern: { context, selector, strictness } }` | parse `context`, match the `selector` node inside it            |
| `{ kind }`                                       | a bare syntax kind                                              |
| `{ regex, on? }`                                 | over the node's text, or over a binding's                       |
| `{ nthChild }`                                   | position among siblings; number, `odd`/`even`/`An+B`, or object |
| `{ range: { start, end } }`                      | the node occupies exactly this span                             |
| `{ inside, stopBy?, field? }`                    | an ancestor matches                                             |
| `{ has, stopBy?, field? }`                       | a descendant matches                                            |
| `{ follows, stopBy? }` / `{ precedes }`          | an earlier / later sibling statement matches                    |
| `{ all }` / `{ any }` / `{ not }`                | composition                                                     |
| `{ matches: 'name' }`                            | a rule named in `utils`                                         |
| `{ atLeast, of }`                                | **extension** — N _distinct_ members match in the subtree       |
| `{ count: { min, of } }`                         | **extension** — `of` matches at least `min` unwrapped times      |
| `{ fact: { name, …params } }`                    | **extension** — a registered analysis answers for this node (see Facts) |

Alongside the matcher, `defineMatcher` accepts `utils` (named rules `matches` resolves) and
`constraints` (a rule per metavariable, narrowing what it may bind).

## The node model

A file is one tree. Every front-end produces the same `Node` record: `kind`, the `field` it occupies
in its parent, its `fields` map, `children`, `parent`, `text` and a `range` into the original file.
Kinds are namespaced by front-end: bare names are TypeScript syntax kinds (`CallExpression`),
`svelte:Element`, `css:Declaration`, `trivia:JSDocTag` and `sql:` kinds come from the markup
front-end (`src/frontend/markup.ts`). Because the record is one shape, `inside` and `has`
compose across the language boundary: a rule may ask for a call inside a `svelte:Script`. A kind
the front-ends do not produce is a load-time error naming the file, never a rule that silently
matches nothing.

## Field-addressed patterns

A pattern constrains its own kind and the nodes in each field it names, and nothing else.
`const  = ` says nothing about `modifiers`, so it matches `export const a = 1`,
`declare const a: T` and a default export alike; `!` matches an `export`ed non-null assertion
because the pattern is compared field by field, not child by child. A pattern that wants a modifier
says so: `has: { field: modifiers, kind: AsyncKeyword }`. `strictness: cst` is the opt-out, where
every field must correspond.

## Facts

A fact is a named, registered analysis over the file or the repository — `usesImportedRuntime`,
`callSites`, `flowsInto`, `reaches`, `callGraphCycle` and the rest registered in
`src/analyses/index.ts` — invoked from a rule as `{ fact: { name, …params } }`. Each fact declares
its parameter schema (a misspelled parameter is a load error), is memoised per file, is tested on
its own in `tests/facts.test.ts`, and carries no domain vocabulary: word lists, package names and
thresholds are parameters in the rule document, never constants in the analysis.

## Two semantics worth stating

**Operators are part of the shape.** TypeScript does not expose binary/unary operators or `?.` as
`forEachChild` nodes. The matcher still compares them, so `$A && $B` does not match `a || b` and
`$K in $V` does not match `===`.

**`stopBy` defaults to `neighbor`.** `inside` sees the immediate parent; `has` sees direct children.
`'end'` walks the whole chain, and `{ rule: … }` walks until a node matches — **inclusive**, so the
stopping node is itself a candidate (ast-grep's `take_while(inclusive_until(stop))`). Getting this
backwards silently changes every relational rule in the pack, so
`tests/astgrep-parity.test.ts` asserts both directions.

**`field` names a property, not a tree-sitter field id.** TypeScript's AST has no field ids, but it
has named properties carrying the same meaning, so `{ inside: { kind: 'VariableDeclaration' }, field:
'initializer' }` reads as it would in ast-grep.

## Where this differs from ast-grep

`strictness` has four levels where ast-grep has six: `ast` (the default: named fields only), `cst`
(modifiers and every field must correspond), `signature` (shape without text) and `template` (text
without kinds). ast-grep's `smart` and `relaxed` collapse into `ast`: TypeScript's parser gives no
CST layer, so there is no trivia to include or exclude.

There is no `transform` and no autofix. This is a gate, not a codemod — a rule states what is wrong,
and a person decides what to write instead.

`atLeast` has no ast-grep equivalent. It is the combinator the legacy `QRY1` needed: "this scope exhibits several distinct bypass
mechanisms and never calls the owner" is a claim about _mechanism plus absence_, which survives an
agent renaming every identifier in the file.

## Authoring notes

A pack rule lives in `packs/<name>/<id>.yaml`. Examples on a `rule` document are executed: a
shape that cannot demonstrate a positive and a negative is not a rule. `tests/port.test.ts`
asserts both halves for every rule in every pack.

A constraint naming a metavariable the matcher never binds is rejected when the rule is authored,
not when it happens to match — a misspelled key would otherwise report nothing for ever, which reads
exactly like a clean codebase.
