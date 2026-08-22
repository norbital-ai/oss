import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate
} from '@codemirror/view';

const fencedCodeLine = Decoration.line({ class: 'cm-md-codeblock' });
const blockquoteLine = Decoration.line({ class: 'cm-md-blockquote' });

const headingDecorations = new Map<string, Decoration>([
	['ATXHeading1', Decoration.line({ class: 'cm-md-heading cm-md-h1' })],
	['ATXHeading2', Decoration.line({ class: 'cm-md-heading cm-md-h2' })],
	['ATXHeading3', Decoration.line({ class: 'cm-md-heading cm-md-h3' })],
	['ATXHeading4', Decoration.line({ class: 'cm-md-heading cm-md-h4' })],
	['ATXHeading5', Decoration.line({ class: 'cm-md-heading cm-md-h5' })],
	['ATXHeading6', Decoration.line({ class: 'cm-md-heading cm-md-h6' })],
	['SetextHeading1', Decoration.line({ class: 'cm-md-heading cm-md-h1' })],
	['SetextHeading2', Decoration.line({ class: 'cm-md-heading cm-md-h2' })]
]);

function markLines(
	view: EditorView,
	from: number,
	to: number,
	decoration: Decoration,
	lines: Map<number, Decoration>
) {
	const start = view.state.doc.lineAt(from).number;
	const end = view.state.doc.lineAt(Math.max(from, to - 1)).number;
	for (let number = start; number <= end; number++) {
		if (!lines.has(number)) lines.set(number, decoration);
	}
}

function buildDecorations(view: EditorView): DecorationSet {
	const lines = new Map<number, Decoration>();
	for (const range of view.visibleRanges) {
		syntaxTree(view.state).iterate({
			from: range.from,
			to: range.to,
			enter(node) {
				if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
					markLines(view, node.from, node.to, fencedCodeLine, lines);
					return false;
				}
				if (node.name === 'Blockquote') {
					markLines(view, node.from, node.to, blockquoteLine, lines);
					return false;
				}
				const heading = headingDecorations.get(node.name);
				if (heading) {
					markLines(view, node.from, node.to, heading, lines);
					return false;
				}
				return true;
			}
		});
	}
	const builder = new RangeSetBuilder<Decoration>();
	for (const lineNumber of [...lines.keys()].sort((left, right) => left - right)) {
		const decoration = lines.get(lineNumber);
		if (decoration === undefined) continue;
		const line = view.state.doc.line(lineNumber);
		builder.add(line.from, line.from, decoration);
	}
	return builder.finish();
}

export function markdownBlockDecorations(): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = buildDecorations(view);
			}
			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildDecorations(update.view);
				}
			}
		},
		{ decorations: (value) => value.decorations }
	);
}
