import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("mongoose", () => ({
  default: {
    connect: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("config/db shutdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["SIGINT", "SIGTERM"])(
    "disconnects from MongoDB and exits cleanly on %s",
    async (signal) => {
      const handlers = {};
      const on = vi.spyOn(process, "on").mockImplementation((event, fn) => {
        handlers[event] = fn;
        return process;
      });
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      vi.resetModules();
      const { default: mongoose } = await import("mongoose");
      await import("../../../config/db.js");
      on.mockRestore();

      expect(handlers[signal]).toBeTypeOf("function");
      await handlers[signal]();

      expect(mongoose.disconnect).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    }
  );
});
