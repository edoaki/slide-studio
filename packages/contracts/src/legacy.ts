import type { Doc } from "../../core/src/legacy-source.js";
import type { Workspace } from "../../core/src/legacy-workspace.js";
export interface LegacySlide {
  index: number; page: number | null; id: string; title: string;
  level: 1 | 2; figures: string[];
}
export interface LegacyRendered {
  html: string; slides: LegacySlide[]; doc: Doc; version: string;
  warnings: string[]; missing_cites: string[]; cited: string[];
  unsupported: Array<Record<string, unknown>>; timing: Record<string, number>;
}
export interface LegacyRenderOptions { pandocPath: string; wrap?: boolean }
export type LegacyRenderText = (
  workspace: Workspace, deck: string, text: string, options: LegacyRenderOptions
) => Promise<LegacyRendered>;
export interface LegacyFeatureRequest {
  method: string; pathname: string; query: URLSearchParams;
  body: unknown; bytes: Uint8Array; headers: Record<string, string | undefined>;
}
export interface LegacyFeatureResponse {
  status?: number; body?: unknown; bytes?: Uint8Array;
  headers?: Record<string, string>;
}
export type LegacyFeatureHandler = (request: LegacyFeatureRequest) => Promise<LegacyFeatureResponse | null>;
