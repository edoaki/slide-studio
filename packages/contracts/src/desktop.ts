/** First runnable desktop slice. Raw-source editing; legacy feature parity is not implied. */
export interface DeckSummary { id: string; title: string; updatedAt: string }
export interface Diagnostic { code: string; severity: 'warning' | 'error'; message: string; line?: number }
export type CoreErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'OUTSIDE_ROOT' | 'LOCKED' | 'INVALID_INPUT' | 'READ_ONLY' | 'RENDER_TIMEOUT' | 'RENDER_FAILED' | 'BUSY';
/** Implemented core errors expose code; CONFLICT additionally exposes currentVersion. */
export interface CoreFailure extends Error { code: CoreErrorCode; currentVersion?: string }
/** source is UTF-8 text normalized to LF without BOM for textarea use; version hashes original bytes. */
export interface DeckDocument extends DeckSummary { source: string; version: string; eol: 'lf' | 'crlf' | 'mixed'; bom: boolean; readOnly: boolean; diagnostics: Diagnostic[] }
export interface SlideInfo { index: number; id: string; title: string; level: number }
export interface PreviewDocument { html: string; version: string; slides: SlideInfo[]; warnings: Diagnostic[] }
export interface WorkspaceInfo { root: string; decks: DeckSummary[] }
export interface WorkspaceService {
  readonly root: string;
  listDecks(): Promise<DeckSummary[]>;
  createDeck(title: string): Promise<DeckDocument>;
  readDeck(id: string): Promise<DeckDocument>;
  saveDeck(id: string, source: string, expectedVersion: string): Promise<DeckDocument>;
  renderDeck(id: string, source?: string): Promise<PreviewDocument>;
  close(): Promise<void>;
}
export interface OpenWorkspaceOptions {
  /** Explicit executable chosen by host; never taken from document metadata. */
  pandocPath: string;
  /** Create a sample only in the dedicated first-run trial workspace. */
  sample?: boolean;
}
export interface DesktopHostOptions {
  workspace: WorkspaceService;
  uiDirectory: string;
  /** Native folder dialog and workspace replacement; null means cancelled. */
  selectWorkspace?: () => Promise<WorkspaceService | null>;
  /** Host chooses destination via native dialog; returns basename only. */
  exportDocument?: (document: PreviewDocument, format: 'html' | 'pdf', title: string) => Promise<string | null>;
  onShutdown?: () => Promise<void>;
}
export interface DesktopHost {
  adminOrigin: string;
  contentOrigin: string;
  /** In-memory credential. Never log or place in content URLs. */
  token: string;
  close(): Promise<void>;
}
/** All /api routes require X-Studio-Token. Mutations also require exact Origin and JSON. */
export const DESKTOP_API = {
  workspace: '/api/workspace', // GET => WorkspaceInfo
  selectWorkspace: '/api/workspace/select', // POST {} => WorkspaceInfo | {cancelled:true}
  decks: '/api/decks', // POST {title} => DeckDocument (201)
  // GET /api/deck/:id/source => DeckDocument
  // PUT /api/deck/:id/source {source,version} => DeckDocument; 409 on stale version
  // POST /api/deck/:id/preview {source?} => PreviewResponse
  // POST /api/deck/:id/export {format:'html'|'pdf',source?} => {file:string|null}
} as const;
export interface PreviewResponse {
  url: string; // capability on contentOrigin; no admin token
  version: string;
  slides: SlideInfo[];
  warnings: Diagnostic[];
}
export interface ApiError { error: { code: string; message: string } }
/** Parent validates origin+source; child uses exact parent origin supplied by host bootstrap. */
export type PreviewCommand = { type: 'slide-studio:go'; index: number; step?: number };
export type PreviewEvent = { type: 'slide-studio:ready'; count: number } | { type: 'slide-studio:page'; index: number; step: number };
