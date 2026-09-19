import type { BweeepApi } from "../preload/index.cjs";

declare global {
  interface Window {
    bweeep: BweeepApi;
  }
}

export {};
