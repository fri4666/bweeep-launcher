import type { BweeepApi } from "../preload/index";

declare global {
  interface Window {
    bweeep: BweeepApi;
  }
}

export {};
