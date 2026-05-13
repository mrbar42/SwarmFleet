import { describe, expect, it } from "vitest";
import { buildTerminalSpawnOptions } from "../handlers/shared/terminal.ts";

describe("terminal prompt", () => {
  it("starts bash with an rcfile that removes the hostname from PS1", () => {
    const spawn = buildTerminalSpawnOptions("/bin/bash", {
      USER: "user",
      HOME: "/home/user",
      PS1: "\\u@\\h:\\w\\$ ",
    });

    expect(spawn.shell).toBe("/bin/bash");
    expect(spawn.args[0]).toBe("-lc");
    expect(spawn.args[1]).toContain("--rcfile");
    expect(spawn.args[1]).toContain("PS1=");
    expect(spawn.args[1]).toContain("\\u:\\w\\$ ");
    expect(spawn.args[1]).not.toContain("\\u@\\h:\\w\\$ ");
    expect(spawn.env.PS1).toBe("\\u:\\w\\$ ");
  });

  it("preserves non-bash login shell behavior while still passing the short PS1", () => {
    const spawn = buildTerminalSpawnOptions("/bin/zsh", {
      HOME: "/home/user",
      PS1: "%n@%m:%~%# ",
    });

    expect(spawn).toEqual({
      shell: "/bin/zsh",
      args: ["-l"],
      env: {
        HOME: "/home/user",
        PS1: "\\u:\\w\\$ ",
      },
    });
  });
});
