/*
 * Where the presenter's projection window opens. Kept free of Electron imports
 * so the display choice can be unit tested.
 */
export interface Rect { x: number; y: number; width: number; height: number }
export interface DisplayArea { id: number; bounds: Rect; workArea: Rect }
export interface ProjectionPlacement {
  bounds: Rect;
  /** True when the window goes to another display and should fill it. */
  external: boolean;
}

const area = (rect: Rect) => rect.width * rect.height;

/**
 * With two or more displays, use the largest display other than the one that
 * shows the main window (a projector or an external monitor) and fill it.
 * Otherwise keep the window in the lower-right quarter of the main display so
 * the presenter can still see it and move it by hand.
 */
export function projectionPlacement(displays: readonly DisplayArea[], owner: DisplayArea): ProjectionPlacement {
  let target: DisplayArea | undefined;
  for (const display of displays) {
    if (display.id === owner.id) continue;
    if (target === undefined || area(display.bounds) > area(target.bounds)) target = display;
  }
  if (target !== undefined) return { bounds: { ...target.workArea }, external: true };
  const work = owner.workArea;
  const width = Math.floor(work.width / 2), height = Math.floor(work.height / 2);
  return { bounds: { x: work.x + work.width - width, y: work.y + work.height - height, width, height }, external: false };
}
