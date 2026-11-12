# Stage 2 selection bridge

Status: Stage 2 selection groundwork is implemented. This is **not** full legacy
UI parity and does **not** claim that direct slide editing works. Stage 3
(drag/drop/handles) and Stage 4 (text editing/cover authors/figure editor)
remain direct same-origin code and are listed below. No visible legacy control
was intentionally removed or hidden.

## Prerequisite

`packages/web/chat.js` now uploads chat attachments through `uploadFetch` from
`packages/web/api.js`, matching `assets.js` and `materials.js`. `api.js` and the
API tests were not modified.

## Files

- `packages/web/bridge/protocol.js` — runtime validators for the frozen
  `SelectionCommand`, `SelectionIntent` and `EditLayout` shapes, plus
  `edit.layout` / `edit.intent` events.
- `packages/web/bridge/frame-selection.js` — new content-side Stage 2 controller.
  It starts after `deckReady` and is not a static import of `inject/edit.js`.
- `packages/web/bridge/frame-agent.js` — captures DOM intrinsics before authored
  scripts, adds the edit commands/events, initializes selection after
  `deckReady`, and destroys it with the bridge.
- `packages/web/bridge/agent-client.js` — parent cache and validation for
  revision-scoped layout/intent traffic.
- `packages/web/preview.js` — exposes the validated `preview.edit` API and
  layout/intent subscriptions; it still exposes the legacy `win` getter only for
  unmigrated Stage 3/4 callers.
- `packages/web/blocks.js` — Stage 2 sites use `preview.edit`; direct Stage 3/4
  sites remain and are guarded where a cross-origin exception would otherwise
  break selection.
- `packages/web/qmd-blocks.js` — qmd hover is sent through `edit.hover`; step
  badge figure inspection remains a direct site.
- Tests: `tests/bridge/protocol.test.ts`, `tests/bridge/electron.test.ts`, and
  fixtures under `tests/bridge/fixtures/`.

`packages/contracts/src/edit-bridge.ts` was not edited. The frozen contract is
used as-is:

- `edit.configure { sourceVersion, keys, layers, keymap, enabled }`
- `edit.select { key, frameKey }`
- `edit.hover { key }`
- `edit.designing { active }`
- `edit.measure {}`
- `edit.layout` carries `EditLayout`; `edit.intent` carries `SelectionIntent`.

## Implemented behavior

- Selection click hit testing is ported from `inject/edit.js` (`onText`, leaf
  lookup, empty-cell handling, line-end flag). Only trusted original click
  events emit `select` intents; synthetic clicks are ignored.
- Frame hover is ported from `inject/edit.js` (`pointermove`/`pointerout`) and
  emits `hover` intents. Parent qmd hover calls `edit.hover`; the frame adds the
  original `.slide-studio-hover` class.
- `edit.select` applies the original `.slide-studio-selected`,
  `.slide-studio-quiet` and `.slide-studio-frame` classes.
- `edit.configure` applies source-layer colours to
  `data-slide-studio-layer` and replaces the legacy `layers(map)` call.
- Partial geometry is cached by key. Every layout entry has frame CSS-pixel
  `rects` and an `align` value. The parent adds the iframe offset when placing
  the toolbar or computing the decoration avoid rectangle.
- `EditLayout.selection` is the union of the selected/frame key. Parent toolbar
  placement and decoration avoidance read the validated cache, not the frame
  DOM.
- Layout is republished on configure/select, resize, stage mutations, root
  theme class/style changes, theme revision changes and explicit `edit.measure`,
  coalesced to one animation frame.
- The pushed keymap consumes only plain `W A S D Q E R F Escape` while selection
  is enabled; it forwards `keydown`/`keyup` intents. Editable targets, IME
  composition and unrelated keys are untouched. `R`/`F` hold state and clear on
  keyup/frame blur.
- `edit.designing` drives the original `.slide-studio-designing` class.

## Validation and revision rules

- Every command is checked against the protocol identity before execution.
- `edit.configure.sourceVersion` must equal the frame's actual committed
  revision. The frame only changes that revision after a successful theme swap;
  a configure request never advances it.
- The parent compares layout/intent `sourceVersion` to the revision from the
  latest validated frame snapshot. Stale revisions are dropped.
- Layout and intent sequences must increase. Duplicate/stale sequences are
  dropped.
- Layout keys must be configured keys. Duplicate keys, excessive key/rect
  counts, non-finite/out-of-range rectangles and unknown alignment values are
  rejected. `parseEditLayout` returns a fresh bounded copy.
- Select/hover/step-menu commands with unknown keys are rejected by the frame.
  Select/step-menu/key intents must be trusted; untrusted intents are dropped.
  The parent also checks key intents against the configured keymap.
- Parent source-structure checks happen before selection/hover are applied.
  Stage 2 key intents cannot write source; future writing keys must additionally
  require `live()`, current source revision and parent user activation.

## Tests

The integrator runs:

```sh
pnpm typecheck
pnpm test:renderer
SLIDE_STUDIO_BRIDGE_E2E=1 pnpm test:renderer
```

Added coverage:

- Pure malformed `edit.configure`/`edit.select`/`edit.layout`/`edit.intent`
  payload rejection.
- Real sandboxed Electron test across two origins with the Stage 1 fixture plus
  `tests/bridge/fixtures/selection-deck.html` and the original edit CSS marks.
- Trusted click selection, parent→frame hover, frame→parent hover, toolbar
  placement from frame geometry plus iframe offset, geometry refresh after
  resize, theme revision handling, WASD/QE key intents, R/F hold/keyup/blur
  cleanup, synthetic-click rejection and unknown-key rejection.

No test was run by the implementation session; these are handed to the
integrator.

## Still direct frame DOM (Stage 3 / Stage 4)

These sites were intentionally left in place. They are not migrated by Stage 2
and must not be treated as working across the cross-origin boundary yet.

Stage 3 (drag/drop/handles):

- `packages/web/block-handles.js`: `scale()` (`env.win.document.querySelector`),
  `els()` (`env.win.slideStudioEdit.elements`), element style/rect reads,
  pointerup listener on `env.win`, `tableHandles(env.win.slideStudioEdit.table)`,
  computed-style/`slideStudioSpacing` calls, `createTreeWalker`/`createRange`
  padding handles. Inventory IF-031…IF-035.
- `packages/web/block-drag.js`: `w.slideStudioEdit.elements/leafAt`, `w.document.elementFromPoint`,
  editing-element query, stage rect/scale, drag-source classes,
  `slideStudioEdit.swallowClick`, page-strip hit testing. Inventory IF-036…IF-041.
- `packages/web/blocks.js`: `drawHandles()` still hands `ctx.preview.win` to
  `block-handles` (guarded to avoid cross-origin crashes); cover/table/step-menu
  DOM reads at lines around `current` toolbar construction
  (`slideStudioEdit.elements`, `cellAt`, `table`, `markStep`, `deck.stageNumber`).
- `packages/web/cover-authors.js`: cover author target/geometry/computed-style
  and pointer listeners. Inventory IF-062…IF-064.

Stage 4 (text/theme/form/overlays):

- `packages/web/blocks.js`: `makeTextFormat(() => ctx.preview.win, ...)`,
  `.slide-studio-editing` lookup, `start/startHeading/startCell`, `sync`, table
  toolbar computed style, theme variable DOM preview/clear. Inventory
  IF-018…IF-030.
- `packages/web/text-format.js`: `win()?.slideStudioEdit`, theme CSS variables,
  editing-element computed style. Inventory IF-042…IF-044.
- `packages/web/qmd-blocks.js`: step-badge figure `slideStudioEdit.elements`
  inspection (guarded). Inventory IF-060.
- `packages/web/cover-form.js`, `decoration.js`, `block-design.js`,
  `theme-tab.js`, `gradient-editor.js`, `editor.js`, `checks.js`,
  `layout-lint.js`, `bibliography.js`, `insert.js` remain as inventoried in
  `docs/migration/ui-parity.json`.
- `packages/web/preview.js` still exposes `win` for those callers; new Stage 2
  code does not read the content document/window runtime through it.

## Known limits

- The content agent is same-realm with authored deck scripts. Capturing
  intrinsics early protects the measured/hit-test paths, but this document does
  not claim a fully isolated content script world.
- The frozen `layers` contract permits only `"1" | "2" | "3"`. Legacy
  html/image tone names are therefore mapped to source layer `"3"` until a
  contract revision exposes them.
- The host still does not enable the legacy `inject/edit.js` injection; Stage 2
  selection is owned by the frame agent. Stage 4 must merge text editing into
  this controller rather than add duplicate listeners.
- Stage 3 and Stage 4 are not complete, and their controls must not be presented
  as working cross-origin until their dedicated bridge APIs and tests land.
