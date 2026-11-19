export { CoreError, isCoreError } from "./errors.js";
export { bundleCss, bundleHtml } from "./bundle.js";
export { decodeDeckBytes, encodeSourceForDeck, normalizeSource, sha256 } from "./encoding.js";

export type {
  CoreErrorCode,
  CoreFailure,
  Diagnostic,
  PreviewDocument,
  SlideInfo,
} from "../../contracts/src/desktop.js";
