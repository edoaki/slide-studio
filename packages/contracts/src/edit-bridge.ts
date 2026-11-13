/** Boundary contract for the preserved legacy UI. No DOM/Node handles cross it. */
export const EDIT_BRIDGE_PROTOCOL = "slide-studio-edit/1" as const;
export interface FrameIdentity { deck: string; version: string; generation: string }
export interface SlideSnapshot {
  index: number; page: number | null; id: string; title: string; chapter: boolean;
  cites?: string[];
  group: string; sectionStart: boolean; maxStep: number; pdfMarks: number[];
}
export interface FrameSnapshot extends FrameIdentity {
  index: number; step: number; maxStep: number; slides: SlideSnapshot[];
  background: string; scale: number;
  /** Committed source revision represented after a successful theme-only swap.
   * The transport identity/version remains the immutable bootstrap revision. */
  sourceVersion?: string;
  hasReferences?: boolean;
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
  fontSize?: number;
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
  | { method: "edit.issues"; params: { rects: Array<{x:number;y:number;w:number;h:number}>; level: "error" | "warning" } }
  | { method: "edit.locks"; params: { figures: string[]; color: string } }
  | { method: "edit.measure"; params: Record<string, never> };
export interface EditPoint { x:number; y:number; lineEnd?:boolean }
export interface CellPosition { r:number; c:number }
export type TextCommand =
  | { method:"text.begin"; params:{lease:string;sourceVersion:string;key:string|null;html:string;plain?:boolean;heading?:boolean;point?:EditPoint;cell?:CellPosition;cells?:Array<Array<{direct:boolean;html:string}>>;create?:"before"|"after"|"start"|"end"|"col-before"|"col-after"|"wrap-left"|"wrap-right"} }
  | { method:"text.cellAt"; params:{key:string;point:EditPoint} }
  | { method:"text.command"; params:{lease:string} & (
      {action:"finish"|"focus"|"bold"|"italic"|"clearFormat"|"linkState"}
      | {action:"color";value:string|null}
      | {action:"size";value:number}
      | {action:"stepSize";value:-1|1}
      | {action:"align";value:"left"|"center"|"right"|"justify"}
      | {action:"setLink";value:string|null;text?:string}) };
export type LayoutCommand =
  | {method:"edit.themeValues"|"cover.inspect"|"block.clear"|"block.cancel";params:Record<string,never>}
  | {method:"edit.themePreview";params:{values:Record<string,string|null>}}
  | {method:"edit.markStep";params:{step:number|null}}
  | {method:"cover.configure";params:{enabled:boolean}}
  | {method:"cover.select";params:{selected:boolean}}
  | {method:"block.configure";params:{sourceVersion:string;key:string|null;live:boolean;padMode:"inner"|"outer"|"gap"|null;color:string;text?:string;structure?:Record<string,unknown>}}
  | {method:"block.dropAt";params:EditPoint};
export type ThemeCommand =
  | {method:"theme.configure";params:{shown:boolean;sample:boolean}}
  | {method:"theme.preview";params:{vars:Record<string,string>;values:Record<string,string>;shown:boolean}}
  | {method:"theme.inspect";params:{key?:string}}
  | {method:"theme.mark";params:{key:string|null}}
  | {method:"theme.gradient";params:{action:"open";key:string}|{action:"content";showContent:boolean}|{action:"close"|"geometry"}}
  | {method:"lint.inspect";params:Record<string,never>};
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
export type FrameRequest = (NavigationCommand | SelectionCommand | TextCommand | LayoutCommand | ThemeCommand) & FrameIdentity & {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "request"; id: number;
};
export interface FrameResponse extends FrameIdentity {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "response"; id: number;
  ok: boolean; result?: unknown; error?: { code: string; message: string };
}
export type FrameEvent = FrameIdentity & {
  protocol: typeof EDIT_BRIDGE_PROTOCOL; type: "event";
  event: "ready" | "deckchange" | "layout" | "key" | "link.open" | "failure" | "edit.layout" | "edit.intent" | "text.state" | "text.heading" | "cover.intent" | "block.intent" | "theme.select" | "edit.lint" | "insert.pointer" | "insert.paste";
  data: unknown;
};
// Text sessions carry source revisions and single-session leases; frame events
// describe edits while the host revalidates and performs manuscript writes.
// No generic eval/function/selector-to-admin/URL-open/HTTP command is permitted.
