# Staged secure preview/presentation bridge (Stage 1)

Status: bridge groundwork only. This stage does **not** claim full legacy UI
parity and does not migrate the direct-edit callbacks listed at the end. No
host/core files are changed by this stage. The full editor is not usable until
its remaining frame callers and backend services have been migrated.

## Files

- `packages/web/bridge/protocol.js` — runtime protocol constants, validation,
  fragment-nonce handling, snapshot/request/response/event parsing.
- `packages/web/bridge/frame-agent.js` — ES-module source for the content-side
  agent. The integrator bundles it to a classic IIFE with esbuild 0.28.2.
- `packages/web/bridge/agent-client.js` — parent-side MessageChannel client,
  cached snapshot API, bounded RPC timeouts and navigation invalidation.
- Adapted callers: `packages/web/preview.js`, `packages/web/present.js`,
  `packages/web/external-links.js`, and the wheel hook in
  `packages/web/app.js`.
- Frozen shared types: `packages/contracts/src/edit-bridge.ts` (integrator
  owned; not edited here).

`preview.js` and `present.js` do not read `contentDocument`, the content
document, or `contentWindow.deck`. They receive validated snapshots over the
private port. The legacy `preview.win` getter remains only for callers that
have not been migrated yet; new code must use `preview.api`.

## Parent capability request (future host route)

The parent still uses the existing `api()` helper from `packages/web/api.js`
(unchanged in this stage). The session/auth API adapter remains future work; no
token or session state is passed to the content origin. The host must provide:

```http
POST /api/deck/{id}/preview
Content-Type: application/json

{ "version": "<version>", "mode": "edit" | "present", "generation": "<opaque per-load id>" }
```

Response:

```json
{ "url": "https://content-origin.example/files/decks/<id>/__slide-studio_preview__.html?...", "origin": "https://content-origin.example", "version": "<version>" }
```

Requirements:

- `url` must be an absolute `http:` or `https:` capability URL.
- `origin` must exactly equal the URL origin (compared after URL parsing)
  and differ from the admin origin; the client enforces this separation.
- `version` must be a non-empty string and must match the version used in the
  content bootstrap script.
- The response must not contain an API token. The only per-load secret is the
  nonce, which the parent appends to the URL fragment.
- The resolver applies the same authorization/session checks as the legacy
  preview route. A bare `/files/...` URL is not an acceptable substitute once
  the route is enabled.
- Register the route before the generic `POST /api/deck/{deck}/{action}`
  dispatcher so `preview` is not treated as an action string.

The parent appends the legacy page/step fragment plus nonce:

```text
...?v=<version>&generation=<generation>#<page>/<step>&n=<nonce>
```

For presentation only, the parent also adds `studio-mode=present`. This lets
the same agent distinguish presentation keys without changing the frozen
script attributes. The capability resolver may already put `mode=present` or
`edit=0` in the URL; the agent recognizes those too. Edit mode needs no hint
and remains the default.

## Content bootstrap script (host provides)

The host must inject this as the **first classic `<head>` script**, before any
authored deck script, with no `type="module"`, `defer`, or `async`:

```html
<script
  data-studio-admin-origin="https://admin-origin.example"
  data-studio-deck="<deck id>"
  data-studio-version="<version>"
  data-studio-generation="<generation>"
  src="https://content-origin.example/bridge/frame-agent.classic.js"></script>
```

- Serve `bridge/frame-agent.classic.js` from the content origin as
  `text/javascript`. It is the integrator-built classic IIFE of
  `packages/web/bridge/frame-agent.js`; do not serve the ES module source
  directly to the browser.
- The preview document's frame policy (`frame-ancestors`/`frame-src` as
  applicable) must allow the admin origin to embed it, while still preventing
  the content origin from embedding admin pages.
- `data-studio-admin-origin` must be the exact admin origin used as the
  `postMessage` target origin.
- `data-studio-deck`, `data-studio-version`, and `data-studio-generation` must
  equal the values used to create the capability URL. The parent validates all
  three on every request/event/response.
- Optional: `data-studio-mode="edit"|"present"`. Without it the agent infers
  presentation mode from `studio-mode`, `mode=present`, or `edit=0`.
- Do not expose the admin token, session cookie, filesystem paths, or API
  adapter inside the content document. The agent has no access to them.

### Handshake

1. The agent captures the built-ins it needs (`postMessage`,
   `MessageChannel`, `getComputedStyle`, `addEventListener`, geometry and
   history methods).
2. It reads the nonce from the fragment and calls `history.replaceState` with
   the original path/search and the fragment minus only `n=...`. The legacy
   `#page/step` fragment is preserved for authored scripts.
3. It posts `{protocol:"slide-studio-edit/1", type:"hello", nonce}` to the
   admin origin and transfers exactly one `MessagePort`.
4. The parent accepts only `event.origin === contentOrigin`,
   `event.source === pending.contentWindow`, the expected nonce, and exactly
   one port. A second hello is ignored; all later traffic is port-only.
5. A second iframe `load` (navigation/reload) invalidates the generation,
   closes the port, rejects pending RPCs, and never reattaches.

### Theme route

`theme.swap` accepts a theme **name**, never a URL or filesystem path. The
content agent encodes the name once and loads:

```http
GET /theme/{encodeURIComponent(name)}.css?version={encodeURIComponent(version)}
```

Serve this from the content origin as a future host route, before any catch-all
static mount. The agent keeps the current `#slide-studio-theme` link until the
replacement loads (legacy no-flash behavior), then removes the old link and
refreshes spacing.

## Parent API exposed by `Preview`/`AgentClient`

Cached reads (`preview.api`):

- `index`, `step`, `count`, `slides`
- `maxStep(index?)`, `pdfMarks(index)`, `stageAt()`, `stageNumber(stage, index?)`

Async commands:

- `go(index, step)`, `move(delta)`, `jump(delta)`, `goStage(stage)`
- `resize()`, `setFilter(indices | null)`
- `theme.swap(name, version)` and `['theme.swap'](name, version)`
- Compatibility only: `pageWheel(wheelEventLike)` for the `app.js` wheel hook.

Commands have a 5 s RPC timeout, except theme swaps (12 s). Ready waits 30 s.
On timeout, navigation, replacement, or destroy, the client closes the port and
rejects pending work. Validation rejects malformed identities, unknown methods,
non-finite numbers, unsafe theme names and non-`http(s)` link reports.

Stage 1 has **no write/edit intent**. There is no command that sends HTML,
JavaScript, a selector, a filesystem path, a file handle, or an arbitrary URL.

## Presentation

`present.js` keeps the same `.present-screen` shell, dialog attributes,
buttons, fullscreen behavior, parent keyboard shortcuts, exit synchronization
and focus return. It now creates an iframe with the `mode:"present"` capability
URL instead of an admin-origin `srcdoc`.

The content agent:

- forwards Escape and F (and the `#fullscreen` button as an F intent) over the
  existing `key` event;
- attaches the same capture listeners to same-origin nested figure iframes and
  skips cross-origin ones, matching the legacy try/catch behavior;
- forwards link clicks as `link.open`, and the parent performs
  `POST /api/open-external` with its own session.

Exit synchronization uses the last validated snapshot (slide id, index, step)
and calls `ctx.preview.go(...)`; the parent never reads the presentation deck.

## Security boundaries retained

- `nodeIntegrationInSubFrames` stays `false`.
- The isolated-preload idea in the design note remains unverified and is not
  used. The first classic agent is the only mechanism implemented here.
- Content receives no API token, filesystem access, or admin API adapter.
- The parent validates every snapshot, request/response, and event identity.
- The parent file list still contains legacy direct-edit callers; those remain
  pending and are not hidden or disabled.

## Pending direct-edit callbacks (later stages)

The following inventory surfaces still use the legacy same-origin callbacks and
are **not** migrated in Stage 1 and cannot work against a cross-origin frame.
Their visible controls remain in the source, but this is not feature parity.
They must be migrated with typed schemas, leases and tests before delivery:

- `packages/web/blocks.js`: `slideStudioEdit` configure/select/start/finish/
  create/format/elements, direct DOM geometry, version flag.
- `packages/web/block-handles.js`: element/table/spacing DOM and geometry.
- `packages/web/block-drag.js`: drop query, leaf/point lookup, drag styles.
- `packages/web/text-format.js`, `packages/web/table-tools.js`: text/table
  formatting state and commands.
- `packages/web/cover-authors.js`, `packages/web/cover-form.js`,
  `packages/web/decoration.js`, `packages/web/block-design.js`.
- `packages/web/theme-tab.js`, `packages/web/gradient-editor.js`: arbitrary
  theme DOM probing and live preview styles.
- `packages/web/editor.js`: AI-lock outlines, reference-page probe, version
  flag reads.
- `packages/web/checks.js`, `packages/web/layout-lint.js`,
  `packages/web/bibliography.js`, `packages/web/qmd-blocks.js`,
  `packages/web/insert.js`.
- Figure animation access in `packages/web/topic.js`,
  `packages/web/asset-preview.js`, `packages/web/step-badge.js` and the injected
  `inject/*.js` runtimes.
- Theme sample iframe access (`__theme-sample__`) and the legacy injected
  `slideStudioEdit`/`slideStudioLint` globals.

These callbacks are write-capable or arbitrary-DOM operations and require their
own trusted-gesture leases, validation and parity tests before migration.

## Review repairs and validation

The theme sample uses `POST /api/themes/{name}/preview` with `{generation,
version}` and the same capability response. A raw admin-origin sample iframe
is rejected. The host must send `Cache-Control: no-store` for capabilities.

`theme.swap` also accepts optional `sourceVersion`. Only the visible frame
receives a committed source revision, and only a successful swap publishes it.
The immutable bootstrap identity/version continues to authenticate transport
messages. A cache-busting timestamp never becomes a source revision.

Links require a trusted content click plus active parent user activation and
a parent rate limit. Port methods are captured before authored scripts;
content snapshots are still untrusted input, not a trusted isolated world.

Integrator validation on macOS: TypeScript compilation and all 7 bridge tests
passed, including a real sandboxed Electron session across two origins. The
fixture covers navigation, readiness, theme supersession, revision updates,
trusted and synthetic links, origin/source/nonce rejection, duplicate hello,
stale messages and reload cleanup. This is a bridge fixture test, not a full
product parity test. Editor operations, actual host integration, and Windows
runtime validation remain pending.
