# The rule algebra

Rules are written as **shapes**, not as visitors over syntax tokens. The algebra is a port of
ast-grep's `SerializableRule` (`crates/config/src/rule/mod.rs`), so a rule written for ast-grep
translates construct for construct, and its documented semantics are the semantics here.

One entry point, `defineRule`, in two forms. The field holding the shape is called `rule`, which is
what ast-grep calls it, so a rule written against ast-grep's reference translates without renaming.

```ts
// The shape form. This is how a rule should be written.
defineRule({
	id: 'R3e',
	severity: 'error',
	summary: 'single cast to unknown',
	principles: ['simplicity', 'type-safety'],
	rule: {
		all: [
			{ pattern: '$VALUE as unknown' },
			{ not: { inside: { kind: 'AsExpression' }, stopBy: { kind: 'AsExpression' } } }
		]
	},
	examples: { bad: ['const o = v as unknown;'], good: ['const n = t as unknown as number;'] }
});

// The visitor form. The escape hatch, for claims that are not shapes — counting occurrences, or
// reading something about the file rather than the node.
defineRule({
	id: 'EFF7',
	severity: 'error',
	summary: 'single-yield Effect.gen adds no composition',
	principles: ['simplicity'],
	when: ['CallExpression'],
	check(node, context) {
		/* … */
	}
});
```

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

Alongside the matcher, `defineMatcher` accepts `utils` (named rules `matches` resolves) and
`constraints` (a rule per metavariable, narrowing what it may bind).

## Two semantics worth stating

**`stopBy` defaults to `neighbor`.** `inside` sees the immediate parent; `has` sees direct children.
`'end'` walks the whole chain, and `{ rule: … }` walks until a node matches — **inclusive**, so the
stopping node is itself a candidate (ast-grep's `take_while(inclusive_until(stop))`). Getting this
backwards silently changes every relational rule in the pack, so
`tests/astgrep-parity.test.ts` asserts both directions.

**`field` names a property, not a tree-sitter field id.** TypeScript's AST has no field ids, but it
has named properties carrying the same meaning, so `{ inside: { kind: 'VariableDeclaration' }, field:
'initializer' }` reads as it would in ast-grep.

## Where this differs from ast-grep

`strictness` has six levels as in ast-grep, but `cst` and `smart` coincide: TypeScript's parser
gives no CST layer, so there is no trivia to include or exclude. `relaxed`, `signature` (shape
without text) and `template` (text without kinds) are real and distinct.

There is no `transform` and no autofix. This is a gate, not a codemod — a rule states what is wrong,
and a person decides what to write instead.

`atLeast` has no ast-grep equivalent. It is what `defineScope` and `defineCapability` are built on,
and it is the combinator the legacy `QRY1` needed: "this scope exhibits several distinct bypass
mechanisms and never calls the owner" is a claim about _mechanism plus absence_, which survives an
agent renaming every identifier in the file.

## Authoring notes

Examples are mandatory and are executed: a rule that cannot demonstrate a positive and a negative is
not a rule. `tests/port.test.ts` asserts both halves for every rule in every pack.

A constraint naming a metavariable the matcher never binds is rejected when the rule is authored,
not when it happens to match — a misspelled key would otherwise report nothing for ever, which reads
exactly like a clean codebase.
