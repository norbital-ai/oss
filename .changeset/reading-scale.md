---
'@norbital-ai/ui': patch
---

Give `ReadonlyMarkdown` a reading scale, so chat output stops being typeset as a document.

`.tiptap` is editor typography: an `h1` at `text-4xl lg:text-5xl` under a full-width rule, an `h2` at
`text-3xl` under another, and `my-4` between paragraphs. That is right for a page of prose being
written and wrong everywhere markdown arrives *inside* the UI — a model writing `## Cause` in a chat
pane a few hundred pixels wide got a heading larger than the page title and a horizontal rule across
its own reply. `scale="reading"` puts headings back on the app's type scale and tightens the block
rhythm to match the surrounding interface. It only narrows: no new colours, no new families, and
`scale="document"` remains the default so every existing caller is unchanged.
