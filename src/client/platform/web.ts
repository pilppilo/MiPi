/**
 * The browser's `Platform` (COD-245): what the session core and the views get from the page. Every global is read
 * when called, not when this module loads, so importing it is safe where there is no `window` (server-side renders in
 * tests).
 */
import type {
  Notice,
  Platform,
  PlatformStorage,
  ShareData,
  TimerHandle,
  Visibility,
} from "../session/platform.ts";

/** `localStorage`, or nothing: reading it throws where storage is off (some private modes, blocked cookies). */
const local = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/** Never holds secrets (`PlatformStorage`). Each call is guarded: a full, off or blocked storage is just empty. */
const storage: PlatformStorage = {
  get(key) {
    try {
      return local()?.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key, value) {
    try {
      local()?.setItem(key, value);
    } catch {
      // Full or off: the value just doesn't survive a reload.
    }
  },
  remove(key) {
    try {
      local()?.removeItem(key);
    } catch {
      // Off: there is nothing to remove.
    }
  },
};

const visibility = (): Visibility => (document.visibilityState === "hidden" ? "hidden" : "visible");

async function share(data: ShareData): Promise<boolean> {
  if (typeof navigator.share !== "function") return false;
  try {
    await navigator.share(data);
    return true;
  } catch {
    // Cancelled, or the browser refused (no user gesture).
    return false;
  }
}

async function notify({ title, body }: Notice): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") return false;
  new Notification(title, body === undefined ? {} : { body });
  return true;
}

export const webPlatform: Platform = {
  visibility: {
    current: visibility,
    subscribe(listener) {
      const onChange = () => listener(visibility());
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
  },
  storage,
  openLink(url) {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  share,
  notify,
  randomId: () => crypto.randomUUID(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle: TimerHandle) => window.clearTimeout(handle as number),
  logError: (message, error) => console.error(message, error),
};
