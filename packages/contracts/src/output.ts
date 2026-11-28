import type { RenderStep } from '../../renderer/src/contracts.js';
export interface InspectionResult {slides:number;steps:RenderStep[];pdf?:Uint8Array;screenshots:Array<{slide:number;step:number;bytes:Uint8Array}>}
export type InspectDocument=(html:string,options:{pdf:boolean;screenshots:boolean;allSteps:boolean;priorityIndices?:number[]})=>Promise<InspectionResult>;
