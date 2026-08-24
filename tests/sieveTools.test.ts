import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config/config.js";
import { handleSieveTool } from "../src/tools/sieveTools.js";
import type { SieveScript } from "../src/types/sieve.types.js";

/**
 * The activation guard is the safety net around SETACTIVE — the command that
 * silenced 47 production filter rules. These tests drive handleSieveTool with a
 * mocked SieveService and assert that a write never activates and that a switch
 * is never blind.
 */

const state: {
  scripts: SieveScript[];
  setActive: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} = {
  scripts: [],
  setActive: vi.fn(),
  check: vi.fn(),
  put: vi.fn(),
};

vi.mock("../src/services/SieveService.js", () => ({
  SieveService: class {
    connect = vi.fn().mockResolvedValue(undefined);
    authenticate = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    listScripts = vi.fn(async () => state.scripts);
    setActiveScript = (name: string) => state.setActive(name);
    checkScript = (content: string) => state.check(content);
    putScript = (name: string, content: string) => state.put(name, content);
  },
}));

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  })),
}));

const config = { sieve: {} } as unknown as ServerConfig;

const call = (name: string, args: Record<string, unknown>) =>
  handleSieveTool({ params: { name, arguments: args } } as never, config);

const script = (name: string, active: boolean): SieveScript => ({
  name,
  content: "",
  active,
});

describe("sieve tools — activation safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.scripts = [];
  });

  it("create_sieve_filter validates and stores but never activates", async () => {
    const res = await call("create_sieve_filter", {
      name: "mine",
      content: 'require ["fileinto"];\r\nkeep;\r\n',
    });

    expect(state.check).toHaveBeenCalledOnce();
    expect(state.put).toHaveBeenCalledWith(
      "mine",
      'require ["fileinto"];\r\nkeep;\r\n',
    );
    expect(state.setActive).not.toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("NOT active");
  });

  it("activate refuses an unknown script and does not call SETACTIVE", async () => {
    state.scripts = [script("Open-Xchange", true)];

    const res = await call("activate_sieve_script", { name: "typo" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Open-Xchange");
    expect(state.setActive).not.toHaveBeenCalled();
  });

  it("activate switches an existing script and names what it deactivates", async () => {
    state.scripts = [
      script("Open-Xchange", true),
      script("claude-filter", false),
    ];

    const res = await call("activate_sieve_script", { name: "claude-filter" });

    expect(state.setActive).toHaveBeenCalledWith("claude-filter");
    expect(res.content[0].text).toContain("Open-Xchange");
  });

  it("activate is a no-op when the target is already active", async () => {
    state.scripts = [script("Open-Xchange", true)];

    const res = await call("activate_sieve_script", { name: "Open-Xchange" });

    expect(state.setActive).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("already the active");
  });
});
