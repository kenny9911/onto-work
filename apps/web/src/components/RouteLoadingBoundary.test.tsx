import { lazy } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteLoadingBoundary } from "./RouteLoadingBoundary";

afterEach(() => {
  vi.useRealTimers();
});

describe("RouteLoadingBoundary", () => {
  it("keeps the compact loading indicator during the initial pending window", () => {
    vi.useFakeTimers();
    const PendingRoute = lazy(
      () => new Promise<{ default: () => null }>(() => undefined),
    );

    render(
      <RouteLoadingBoundary>
        <PendingRoute />
      </RouteLoadingBoundary>,
    );

    expect(screen.getByRole("status", { name: "Loading interface" })).toBeInTheDocument();
    expect(screen.queryByText("Interface is taking longer than expected")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(9_999));

    expect(screen.getByRole("status", { name: "Loading interface" })).toBeInTheDocument();
  });

  it("offers an injected reload action when loading takes too long", () => {
    vi.useFakeTimers();
    const onReload = vi.fn();
    const PendingRoute = lazy(
      () => new Promise<{ default: () => null }>(() => undefined),
    );

    render(
      <RouteLoadingBoundary onReload={onReload}>
        <PendingRoute />
      </RouteLoadingBoundary>,
    );

    act(() => vi.advanceTimersByTime(10_000));

    expect(
      screen.getByRole("status", { name: "Interface is taking longer than expected" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload interface" }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("turns a rejected lazy route into a recoverable error", async () => {
    const onReload = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const FailedRoute = lazy(() => Promise.reject(new Error("chunk request failed")));

    render(
      <RouteLoadingBoundary onReload={onReload}>
        <FailedRoute />
      </RouteLoadingBoundary>,
    );

    const alert = await screen.findByRole("alert", { name: "Interface failed to load" });
    expect(alert).toHaveTextContent("Interface failed to load");
    fireEvent.click(screen.getByRole("button", { name: "Reload interface" }));
    expect(onReload).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalled();
  });

  it("renders a successfully loaded route without a fallback", async () => {
    const LoadedRoute = lazy(() =>
      Promise.resolve({ default: () => <div>Loaded task route</div> }),
    );

    render(
      <RouteLoadingBoundary>
        <LoadedRoute />
      </RouteLoadingBoundary>,
    );

    expect(await screen.findByText("Loaded task route")).toBeInTheDocument();
    expect(screen.queryByText("Loading interface")).not.toBeInTheDocument();
  });
});
