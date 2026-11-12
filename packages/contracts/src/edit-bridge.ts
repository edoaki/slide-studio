/** Boundary contract for the preserved legacy UI. No DOM/Node handles cross it. */
export const EDIT_BRIDGE_PROTOCOL = "slide-studio-edit/1" as const;
export interface FrameIdentity { deck: string; version: string; generation: string }
export interface SlideSnapshot {
  index: number; page: number | null; id: string; title: string; chapter: boolean;
  group: string; sectionStart: boolean; maxStep: number; pdfMarks: number[];
}
export interface FrameSnapshot extends FrameIdentity {
  index: number; step: number; maxStep: number; slides: SlideSnapshot[];
  background: string; scale: number;
  /** Committed source revision represented after a successful theme-only swap.
   * The transport identity/version remains the immutable bootstrap revision. */
  sourceVersion?: string;
}
export type NavigationCommand =
  | { method: "go"; params: { index: number; step: number } }
  | { method: "move"; params: { delta: number } }
  | { method: "jump"; params: { delta: number } }
  | { method: "goStage"; params: { stage: number } }
  | { method: "resize"; params: Record<string, never> }
  | { method: "setFilter"; params: { indices: number[] | null } }
  | { method: "theme.swap"; params: { name: string; version: string; sourceVersion?: string } }
  | { method: "finish"; params: Record<string, never> };
export interface FrameHello {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "hello"; nonce: string;
}
export type FrameRequest = NavigationCommand & FrameIdentity & {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "request"; id: number;
};
export interface FrameResponse extends FrameIdentity {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "response"; id: number;
  ok: boolean; result?: unknown; error?: { code: string; message: string };
}
export type FrameEvent = FrameIdentity & {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "event";
  event: "ready" | "deckchange" | "layout" | "key" | "link.open" | "failure";
  data: unknown;
};
// Later edit operations require their own schemas and trusted-gesture leases.
// No generic eval/function/selector-to-admin/URL-open/HTTP command is permitted.
