import "@testing-library/jest-dom/vitest";

// jsdom ships no ResizeObserver. Components that keep a measured element in
// sync with its layout only need the constructor to exist here: jsdom never
// lays anything out, so an observer that never fires is the honest stub.
if (!("ResizeObserver" in globalThis)) {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
}
