# What Bolt already renders

Configure built-ins before building custom UI. Props: `workspace_lang` on `@norbital-ai/ui`.

- **Table & toolbar:** text `indexes` + `record_label` enable search; filters/sort/column menu/selection/cursor paging/footer/empty states/approval accents come free (`where` fixed, `initial_filter` default); `toolbar.export` adds CSV (file sync replaces it); ⚡ automatically lists Sync now, file sync Import/Export/Template, and bulk Update/Delete; `toolbar.actions` adds page ops; `create` grant adds New; row click opens `RecordShell` (`?record=<model>/<id>`) unless `on_open`.
- **RecordShell & forms:** renders state pill, lock banner, approval panel (approve/reject/request changes/resubmit), history+restore, and runs. Grants, state edges, `transitions` and `constraints` enforce automatically; ungranted fields render readonly.
- **Kinds & shell:** all Bolt kinds render/edit themselves; enums/states read `models.<m>.fields.<f>.<value>` (`enum_text`/`use_enum_text` — never hand-written label maps). Never rebuild: approval inbox, notifications, Settings (people, org, audit, runs, integrations, secrets), finder (`⌘/`), Studio, kiosk/device walls (`+app.ts` `requires`), or generic integration pairing/test/reconnect.
