import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ApiModule {
  api(path: string, options?: { method?: string; body?: unknown }): Promise<unknown>;
  locationHeaders(target?: string | URL | Request): Record<string, string>;
  uploadFetch(path: string, init?: RequestInit): Promise<Response>;
  onEvent(fn: (event: unknown) => void): () => void;
  toast(message: string): void;
}

interface ToastElement {
  textContent: string;
  className: string;
  setAttribute(name: string, value: string): void;
  classList: { add(name: string): void; remove(name: string): void };
}

export interface TestSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

export interface BrowserEvent {
  persisted?: boolean;
}

export interface BrowserEnv {
  url(): URL;
  history: { state: unknown; replaceState(state: unknown, title: string, url: string): void };
  document: Record<string, unknown>;
  sessionStorage: TestSessionStorage;
  toastText(): string;
  dispatch(type: string, event?: BrowserEvent): void;
  unload(): void;
  cleanup(): void;
}

export function repoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, "package.json"))
      && existsSync(join(current, "packages/web/api.js"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("cannot locate the repository root");
    current = parent;
  }
}

let moduleSequence = 0;

export async function loadApiModule(): Promise<ApiModule> {
  const url = pathToFileURL(join(repoRoot(), "packages/web/api.js")).href;
  return await import(`${url}?case=${++moduleSequence}`) as ApiModule;
}

export async function loadStrings(): Promise<{ S: { authLost: string } }> {
  const url = pathToFileURL(join(repoRoot(), "packages/web/strings.js")).href;
  return await import(`${url}?case=${++moduleSequence}`) as { S: { authLost: string } };
}

export function makeSessionStorage(): TestSessionStorage {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.has(key) ? values.get(key) ?? null : null;
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

function makeDocument(meta: string): {
  document: Record<string, unknown>;
  toastText(): string;
} {
  let toast: ToastElement | null = null;
  const classes = new Set<string>();
  const document = {
    readyState: "complete",
    querySelector(selector: string) {
      if (selector === ".toast") return toast;
      if (selector === "meta[name=slide-studio-location]") return { content: meta };
      return null;
    },
    createElement(tag: string) {
      void tag;
      toast = {
        textContent: "",
        className: "",
        setAttribute() {},
        classList: {
          add(name: string) { classes.add(name); },
          remove(name: string) { classes.delete(name); },
        },
      };
      return toast;
    },
    body: {
      append() {},
    },
  };
  return { document, toastText: () => toast?.textContent ?? "" };
}

export function installEnv(options: {
  href: string;
  meta?: string;
  fetch?: FetchLike;
  sessionStorage?: TestSessionStorage;
}): BrowserEnv {
  const globals = globalThis as unknown as Record<string, unknown>;
  let current = new URL(options.href);
  const location = {
    get href() { return current.href; },
    get origin() { return current.origin; },
    get pathname() { return current.pathname; },
    get search() { return current.search; },
    get hash() { return current.hash; },
    set hash(value: string) { current.hash = value; },
    toString() { return current.href; },
  };
  const history = {
    state: null as unknown,
    replaceState(state: unknown, _title: string, next: string) {
      history.state = state;
      current = new URL(next, current.href);
    },
  };
  const { document, toastText } = makeDocument(options.meta ?? "");
  const sessionStorage = options.sessionStorage ?? makeSessionStorage();
  type Handler = (event?: BrowserEvent) => void;
  const handlers = new Map<string, Set<Handler>>();
  const addEventListener = (type: string, fn: Handler) => {
    let set = handlers.get(type);
    if (!set) { set = new Set(); handlers.set(type, set); }
    set.add(fn);
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    location,
    history,
    document,
    addEventListener,
    fetch: options.fetch ?? globals.fetch,
    sessionStorage,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globals, key));
    // Node の sessionStorage のような getter を、代入ではなく差し替える。
    Object.defineProperty(globals, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }

  const dispatch = (type: string, event: BrowserEvent = {}) => {
    for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
  };

  return {
    url: () => current,
    history,
    document,
    sessionStorage,
    toastText,
    dispatch,
    unload() {
      for (const type of ["beforeunload", "pagehide", "unload"]) dispatch(type, { persisted: false });
    },
    cleanup() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globals, key, descriptor);
        else delete globals[key];
      }
    },
  };
}
