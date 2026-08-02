---
'@norbital-ai/pod': patch
---

Keep browser replica synchronization demand-driven so background collection warming cannot compete with visible reads or issue requests for inaccessible collections. Close a tab's replica transport when the page is actually discarded.
