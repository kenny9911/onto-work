/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

describe("typography contract", () => {
  it("uses the approved English, Chinese, and code font roles", () => {
    const entry = readFileSync(join(sourceRoot, "main.tsx"), "utf8");
    const styles = readFileSync(join(sourceRoot, "styles.css"), "utf8");
    const fontDirectory = join(sourceRoot, "assets", "fonts", "source-han-sans-cn");

    expect(entry).toContain('import "@fontsource-variable/jetbrains-mono";');
    expect(entry).toContain('import "@fontsource-variable/open-sans/wght.css";');
    expect(entry).not.toContain("@fontsource-variable/geist");
    expect(styles).toContain('font-family: "Source Han Sans CN";');
    expect(styles).toContain('"Open Sans Variable", "Open Sans", "Source Han Sans CN"');
    expect(styles).toContain(
      '"JetBrains Mono Variable", "JetBrains Mono", "Source Han Sans CN"',
    );
    expect(styles).toContain("font-display: swap;");
    expect(styles).toContain("unicode-range:");
    expect(
      readFileSync(join(fontDirectory, "SourceHanSansCN-VF.otf.woff2"))
        .subarray(0, 4)
        .toString("ascii"),
    ).toBe("wOF2");
    expect(readFileSync(join(fontDirectory, "LICENSE.txt"), "utf8")).toContain(
      "SIL OPEN FONT LICENSE Version 1.1",
    );
  });

  it("centralizes compact sizes instead of hiding readable text below 12px", () => {
    const violations = [join(sourceRoot, "App.tsx"), ...sourceFiles(join(sourceRoot, "components"))]
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return [...source.matchAll(/\btext-\[(\d*\.?\d+)(px|rem)\]/g)]
          .filter((match) => {
            const value = Number(match[1]);
            return match[2] === "px" ? value < 12 : value * 16 < 12;
          })
          .map((match) => `${path.slice(sourceRoot.length)}: ${match[0]}`);
      });

    expect(violations).toEqual([]);
  });

  it("keeps semantic metadata legible at 12px or larger", () => {
    const styles = readFileSync(join(sourceRoot, "styles.css"), "utf8");
    const sizes = [...styles.matchAll(/--text-ui-(?:micro|meta|code|control|body):\s*([\d.]+)rem/g)];
    expect(sizes).toHaveLength(5);
    for (const [, value] of sizes) expect(Number(value) * 16).toBeGreaterThanOrEqual(12);
  });

  it("defines semantic roles for telemetry, controls, prose, and titles", () => {
    const styles = readFileSync(join(sourceRoot, "styles.css"), "utf8");

    for (const token of ["micro", "meta", "code", "control", "body", "title", "display"]) {
      expect(styles).toContain(`--text-ui-${token}:`);
      expect(styles).toContain(`--text-ui-${token}--line-height:`);
    }
  });
});
