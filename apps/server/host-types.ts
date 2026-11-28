import type { ServerResponse } from "node:http";
import type { FeatureHandler, RenderText, RenderedDeck } from "../../packages/contracts/src/server.js";
import type { InspectDocument } from "../../packages/contracts/src/output.js";
import type { ChunkEditMap } from "../../packages/core/src/edit.js";
import type { Providers } from "../../packages/ai/src/providers.js";
import type { Runner } from "../../packages/ai/src/workflow.js";
import type { BoundedQueueEvents } from "./http.js";

/** Public workspace surface used by the host. Keeping it structural makes test doubles possible. */
export interface HostWorkspace {
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

export interface DiagnosticItem {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
  [key: string]: unknown;
}

export type Diagnostics =
  | DiagnosticItem[]
  | (() => DiagnosticItem[] | Promise<DiagnosticItem[]>);

export type SelectWorkspace = () =>
  | HostWorkspace
  | null
  | Promise<HostWorkspace | null>;

export type OpenExternal = (url: string) => boolean | Promise<boolean>;

export type WorkspaceChanged = (
  next: HostWorkspace,
  previous: HostWorkspace,
) => void | Promise<void>;

export interface ExportDocumentInput {
  deck: string;
  html: string;
  version: string;
  rendered: RenderedDeck | null;
}

export type ExportDocument = (
  document: ExportDocumentInput,
  format: "html" | "pdf",
  title: string,
) => string | null | Promise<string | null>;

export interface HostOptions {
  updates?: {
    state(): unknown;
    check(): Promise<unknown>;
  };
  adminPort?: number;
  /** The caller owns the workspace lock and calls `Workspace.ensure()`. */
  workspace: HostWorkspace;
  /** Directory containing the web UI `app.html` and `/web` assets. */
  uiDirectory: string;
  pandocPath: string;
  /** Injected renderer. */
  renderText: RenderText;
  /** Optional feature extensions. Registered handlers run in array order. */
  featureHandlers?: FeatureHandler[];
  /** Native folder picker. The host never closes either workspace itself. */
  selectWorkspace?: SelectWorkspace;
  openWorkspace?: (path: string, mode: "new" | "existing") => Promise<HostWorkspace | null>;
  recentWorkspaces?: () => string[];
  /**
   * Called after a selected workspace has been committed by the host. The
   * callback receives ownership of `previous`; the host no longer uses it.
   * The caller should release the previous lock here, not in selectWorkspace.
   */
  onWorkspaceChanged?: WorkspaceChanged;
  /** Native OS browser opening. */
  openExternal?: OpenExternal;
  openPath?: (path: string) => Promise<void>;
  /** Brings the presenter's projection window to front; false when none is open (or in browser mode). */
  focusProjection?: () => boolean | Promise<boolean>;
  /** Native save/export adapter. */
  exportDocument?: ExportDocument;
  inspect?: InspectDocument;
  settingsPath?: string;
  applyUiZoom?: (percent: number) => void;
  aiStorage?: string;
  aiProviders?: Providers;
  aiRunner?: Runner;
  /** Injected doctor/environment report for `/api/env`. */
  diagnostics?: Diagnostics;
  warningIssues?: (rendered: RenderedDeck | null) => unknown[];
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

export interface StudioHost {
  adminOrigin: string;
  contentOrigin: string;
  /** In-memory credential. Never log it or put it in content URLs. */
  token: string;
  close(): Promise<void>;
  pending: readonly string[];
  pendingFeatures: readonly string[];
  implemented: readonly string[];
}

export interface SourceSnapshot {
  text: string;
  version: string;
  bytes: Buffer;
  eol: "lf" | "crlf" | "mixed";
  bom: boolean;
}

export interface ChunkEntry {
  rendered: RenderedDeck;
  info: Promise<ChunkEditMap>;
}

export interface DeckState {
  deck: string;
  html: string | null;
  version: string;
  error: string | null;
  rendered: RenderedDeck | null;
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
