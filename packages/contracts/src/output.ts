import type { RenderStep } from '../../renderer/src/contracts.js';
export interface LegacyInspection {slides:number;steps:RenderStep[];pdf?:Uint8Array;screenshots:Array<{slide:number;step:number;bytes:Uint8Array}>}
export type LegacyInspect=(html:string,options:{pdf:boolean;screenshots:boolean;allSteps:boolean})=>Promise<LegacyInspection>;
