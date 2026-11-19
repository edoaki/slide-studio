import type { ServerResponse } from "node:http";
import type { LegacyFeatureHandler, LegacyRenderText, LegacyRendered } from "../../packages/contracts/src/server.js";
import type { LegacyInspect } from "../../packages/contracts/src/output.js";
import type { ChunkEditMap } from "../../packages/core/src/edit.js";
import type { Providers } from "../../packages/ai/src/providers.js";
import type { Runner } from "../../packages/ai/src/workflow.js";
import type { BoundedQueueEvents } from "./http.js";

/** Public workspace surface used by the host. Keeping it structural makes test doubles possible. */
export interface LegacyWorkspace {
  readonly root: string;
  readonly themes: string;
  has_deck(deck: string): boolean;
  qmd(deck: string): string;
  memo(deck: string): string;
  deck_dir(deck: string): string;
  list_decks(): string[];
  recent(): Array<Record<string, unknown>>;
  shelves(): string[];
  list_figures(
    shelf?: string | null,
    deck?: string | null,
  ): Array<Record<string, unknown>>;
  topic_empty(shelf: string): boolean;
  is_untouched(deck: string): boolean;
  is_blank(deck: string): boolean;
  themes_list(): string[];
  prefs(): Record<string, unknown>;
  theme_preparation(): Array<Record<string, unknown>>;
  migration_preparation(): Array<Record<string, unknown>>;
  touch_recent(deck: string): void;
  require_deck(deck: string): string;
  new_deck(
    deck: string,
    shelf: string,
    theme?: string,
    source_deck?: string | null,
    title?: string | null,
  ): string;
  new_topic(shelf: string): string;
}

export interface LegacyDiagnosticItem {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
  [key: string]: unknown;
}

export type LegacyDiagnostics =
  | LegacyDiagnosticItem[]
  | (() => LegacyDiagnosticItem[] | Promise<LegacyDiagnosticItem[]>);

export type LegacySelectWorkspace = () =>
  | LegacyWorkspace
  | null
  | Promise<LegacyWorkspace | null>;

export type LegacyOpenExternal = (url: string) => boolean | Promise<boolean>;

export type LegacyWorkspaceChanged = (
  next: LegacyWorkspace,
  previous: LegacyWorkspace,
) => void | Promise<void>;

export interface LegacyExportDocumentInput {
  deck: string;
  html: string;
  version: string;
  rendered: LegacyRendered | null;
}

export type LegacyExportDocument = (
  document: LegacyExportDocumentInput,
  format: "html" | "pdf",
  title: string,
) => string | null | Promise<string | null>;

export interface LegacyHostOptions {
  updates?: {
    state(): unknown;
    check(): Promise<unknown>;
    download(): Promise<unknown>;
    automatic(value: boolean): Promise<unknown>;
    install(): void;
  };
  adminPort?: number;
  /** The caller owns the workspace lock and calls `Workspace.ensure()`. */
  workspace: LegacyWorkspace;
  /** Directory containing the web UI `app.html` and `/web` assets. */
  uiDirectory: string;
  pandocPath: string;
  /** Injected renderer. */
  renderText: LegacyRenderText;
  /** Optional feature extensions. Registered handlers run in array order. */
  featureHandlers?: LegacyFeatureHandler[];
  /** Native folder picker. The host never closes either workspace itself. */
  selectWorkspace?: LegacySelectWorkspace;
  openWorkspace?: (path: string, mode: "new" | "existing") => Promise<LegacyWorkspace>;
  recentWorkspaces?: () => string[];
  /**
   * Called after a selected workspace has been committed by the host. The
   * callback receives ownership of `previous`; the host no longer uses it.
   * The caller should release the previous lock here, not in selectWorkspace.
   */
  onWorkspaceChanged?: LegacyWorkspaceChanged;
  /** Native OS browser opening. */
  openExternal?: LegacyOpenExternal;
  openPath?: (path: string) => Promise<void>;
  /** Native save/export adapter. */
  exportDocument?: LegacyExportDocument;
  inspect?: LegacyInspect;
  settingsPath?: string;
  applyUiZoom?: (percent: number) => void;
  aiStorage?: string;
  aiProviders?: Providers;
  aiRunner?: Runner;
  /** Injected doctor/environment report for `/api/env`. */
  diagnostics?: LegacyDiagnostics;
  warningIssues?: (rendered: LegacyRendered | null) => unknown[];
  onShutdown?: () => void | Promise<void>;
  watch?: boolean;
  keepAliveMs?: number;
  maxSseConnections?: number;
  maxBodyBytes?: number;
  maxSourceBodyBytes?: number;
  maxUploadBodyBytes?: number;
  shutdownGraceMs?: number;
  maxPreviewCapabilities?: number;
  renderConcurrency?: number;
  renderPending?: number;
}

export interface LegacyHostHandoff {
  status: "in_progress";
  pending: string[];
  implemented: string[];
  notes: string[];
}

export interface LegacyHost {
  adminOrigin: string;
  contentOrigin: string;
  /** In-memory credential. Never log it or put it in content URLs. */
  token: string;
  close(): Promise<void>;
  pending: readonly string[];
  pendingFeatures: readonly string[];
  handoff: LegacyHostHandoff;
}

export interface SourceSnapshot {
  text: string;
  version: string;
  bytes: Buffer;
  eol: "lf" | "crlf" | "mixed";
  bom: boolean;
}

export interface ChunkEntry {
  rendered: LegacyRendered;
  info: Promise<ChunkEditMap>;
}

export interface DeckState {
  deck: string;
  html: string | null;
  version: string;
  error: string | null;
  rendered: LegacyRendered | null;
  rendering: boolean;
  dirty: boolean;
  force: boolean;
  themeOnly: boolean;
  promise: Promise<DeckState> | null;
  chunks: Map<string, ChunkEntry>;
}

export interface PreviewCapability {
  kind: "deck" | "theme";
  html: string;
  deck: string;
  version: string;
  generation: string;
  mode: "edit" | "present";
}

export interface SseClient {
  response: ServerResponse;
  queue: BoundedQueueEvents<Record<string, unknown>>;
  timer: NodeJS.Timeout;
  paused: boolean;
  closed: boolean;
}

export function baseState(deck: string): DeckState {
  return {
    deck,
    html: null,
    version: "",
    error: null,
    rendered: null,
    rendering: false,
    dirty: false,
    force: false,
    themeOnly: false,
    promise: null,
    chunks: new Map(),
  };
}
