export { openWorkspace } from "./workspace.js";
export { CoreError, isCoreError } from "./errors.js";
export { bundleCss, bundleHtml } from "./bundle.js";
export { prepareSource, assemblePreview } from "./render.js";
export { MAX_SOURCE_BYTES, decodeDeckBytes, normalizeSource, sha256 } from "./source.js";

export type {
  CoreErrorCode,
  CoreFailure,
  DeckDocument,
  DeckSummary,
  Diagnostic,
  OpenWorkspaceOptions,
  PreviewDocument,
  SlideInfo,
  WorkspaceInfo,
  WorkspaceService,
} from "../../contracts/src/desktop.js";
