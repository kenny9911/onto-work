import { describe, expect, it } from "vitest";
import { pathForView, routeFromPathname } from "./routes";

describe("browser routes", () => {
  it("parses task deep links and decodes opaque thread identifiers", () => {
    expect(routeFromPathname("/tasks/thread%3Aone")).toEqual({
      view: "workspace",
      threadId: "thread:one",
    });
  });

  it("maps stable settings routes and preserves legacy paths", () => {
    expect(routeFromPathname("/reviews")).toEqual({ view: "reviews" });
    expect(routeFromPathname("/agents/")).toEqual({ view: "agents" });
    expect(routeFromPathname("/settings/providers")).toEqual({ view: "providers" });
    expect(routeFromPathname("/settings/environments")).toEqual({ view: "environments" });
    expect(routeFromPathname("/environments")).toEqual({ view: "environments" });
    expect(routeFromPathname("/settings/capabilities")).toEqual({ view: "capabilities" });
    expect(routeFromPathname("/capabilities")).toEqual({ view: "capabilities" });
    expect(routeFromPathname("/settings/team")).toEqual({ view: "team" });
    expect(routeFromPathname("/team")).toEqual({ view: "team" });
    expect(routeFromPathname("/projects")).toEqual({ view: "projects" });
    expect(routeFromPathname("/settings/usage")).toEqual({ view: "usage" });
    expect(routeFromPathname("/settings/billing/")).toEqual({ view: "billing" });
    expect(routeFromPathname("/settings/audit")).toEqual({ view: "audit" });
    expect(routeFromPathname("/audit")).toEqual({ view: "audit" });
    expect(routeFromPathname("/artifacts")).toEqual({ view: "artifacts" });
    expect(routeFromPathname("/platform")).toEqual({ view: "platform" });
  });

  it("builds canonical paths and falls back safely", () => {
    expect(pathForView("workspace", "thread/one")).toBe("/tasks/thread%2Fone");
    expect(pathForView("reviews")).toBe("/reviews");
    expect(pathForView("agents")).toBe("/agents");
    expect(pathForView("providers")).toBe("/settings/providers");
    expect(pathForView("environments")).toBe("/settings/environments");
    expect(pathForView("capabilities")).toBe("/settings/capabilities");
    expect(pathForView("projects")).toBe("/projects");
    expect(pathForView("usage")).toBe("/settings/usage");
    expect(pathForView("team")).toBe("/settings/team");
    expect(pathForView("billing")).toBe("/settings/billing");
    expect(pathForView("audit")).toBe("/settings/audit");
    expect(pathForView("artifacts")).toBe("/artifacts");
    expect(pathForView("platform")).toBe("/platform");
    expect(routeFromPathname("/unknown")).toEqual({ view: "workspace" });
  });
});
