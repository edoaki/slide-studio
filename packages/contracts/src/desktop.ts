export interface Diagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  line?: number;
}

export type CoreErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'OUTSIDE_ROOT'
  | 'LOCKED'
  | 'INVALID_INPUT'
  | 'READ_ONLY'
  | 'RENDER_TIMEOUT'
  | 'RENDER_FAILED'
  | 'BUSY';

export interface CoreFailure extends Error {
  code: CoreErrorCode;
  currentVersion?: string;
}

export interface SlideInfo {
  index: number;
  id: string;
  title: string;
  level: number;
}

export interface PreviewDocument {
  html: string;
  version: string;
  slides: SlideInfo[];
  warnings: Diagnostic[];
}
