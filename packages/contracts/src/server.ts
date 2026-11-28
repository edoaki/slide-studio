import type { Doc } from "../../core/src/source.js";
import type { Workspace } from "../../core/src/workspace.js";
export interface RenderedSlide {
  index: number; page: number | null; id: string; title: string;
  level: 1 | 2; figures: string[];
}
export interface RenderedDeck {
  html: string; slides: RenderedSlide[]; doc: Doc; version: string;
  warnings: string[]; missing_cites: string[]; cited: string[];
  unsupported: Array<Record<string, unknown>>; timing: Record<string, number>;
}
export interface RenderOptions { pandocPath: string; wrap?: boolean }
export type RenderText = (
  workspace: Workspace, deck: string, text: string, options: RenderOptions
) => Promise<RenderedDeck>;
export interface FeatureRequest {
  method: string; pathname: string; query: URLSearchParams;
  body: unknown; bytes: Uint8Array; headers: Record<string, string | undefined>;
}
export interface FeatureResponse {
  status?: number; body?: unknown; bytes?: Uint8Array;
  headers?: Record<string, string>;
}
export type FeatureHandler = (request: FeatureRequest) => Promise<FeatureResponse | null>;
