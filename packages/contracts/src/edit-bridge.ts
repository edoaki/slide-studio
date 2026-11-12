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
  | { method: "pageWheel"; params: { deltaX: number; deltaY: number; deltaMode: 0 | 1 | 2;
      shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean } }
  | { method: "finish"; params: Record<string, never> };
/** Coordinates are content-frame CSS pixels, never admin-window coordinates. */
export interface EditRect { left: number; top: number; right: number; bottom: number }
export interface EditGeometry {
  key: string; rects: EditRect[]; align: "left" | "center" | "right";
}
export interface EditLayout {
  sourceVersion: string; sequence: number; scale: number;
  blocks: EditGeometry[]; selection: EditRect | null;
}
export interface EditKeyRule {
  code: string; shift: boolean; alt: boolean; ctrl: boolean; meta: boolean;
  preventDefault: boolean;
}
/** Stage 2 config carries only valid source keys and local event policy. */
export type SelectionCommand =
  | { method: "edit.configure"; params: {
      sourceVersion: string; keys: string[]; layers: Record<string, "1" | "2" | "3">;
      keymap: EditKeyRule[]; enabled: boolean;
    } }
  | { method: "edit.select"; params: { key: string | null; frameKey: string | null } }
  | { method: "edit.hover"; params: { key: string | null } }
  | { method: "edit.designing"; params: { active: boolean } }
  | { method: "edit.locks"; params: { figures: string[]; color: string } }
  | { method: "edit.measure"; params: Record<string, never> };
export type SelectionIntent = {
  sourceVersion: string; sequence: number;
} & (
  | { kind: "select"; key: string | null; again: boolean; text: boolean;
      point: { x: number; y: number; lineEnd: boolean } | null; trusted: boolean }
  | { kind: "hover"; key: string | null }
  | { kind: "stepMenu"; key: string; trusted: boolean }
  | { kind: "blur" }
  | { kind: "key"; type: "keydown" | "keyup"; key: string; code: string;
      repeat: boolean; isComposing: boolean; trusted: boolean;
      mods: { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean } }
);
export interface FrameHello {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "hello"; nonce: string;
}
export type FrameRequest = (NavigationCommand | SelectionCommand) & FrameIdentity & {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "request"; id: number;
};
export interface FrameResponse extends FrameIdentity {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "response"; id: number;
  ok: boolean; result?: unknown; error?: { code: string; message: string };
}
export type FrameEvent = FrameIdentity & {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "event";
  event: "ready" | "deckchange" | "layout" | "key" | "link.open" | "failure" | "edit.layout" | "edit.intent";
  data: unknown;
};
// Later edit operations require their own schemas and trusted-gesture leases.
// No generic eval/function/selector-to-admin/URL-open/HTTP command is permitted.
