import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UserSummary } from "@agent-harness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginScreen } from "./LoginScreen";

const loginMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: { login: loginMock },
}));

const authenticatedUser: UserSummary = {
  id: "7e819706-1d8a-4a73-ad95-6a797dc2f6e3",
  tenantId: "ea2efc13-fd64-45e4-b657-7deacdd2507f",
  username: "admin",
  displayName: "Administrator",
  role: "admin",
  status: "active",
  mustChangePassword: false,
  createdAt: "2026-09-02T00:00:00.000Z",
  lastLoginAt: "2026-09-02T00:01:00.000Z",
};

describe("LoginScreen", () => {
  beforeEach(() => {
    loginMock.mockReset();
  });

  it("submits workspace credentials and returns the authenticated user", async () => {
    const onAuthenticated = vi.fn();
    loginMock.mockResolvedValue({ user: authenticatedUser });
    render(<LoginScreen onAuthenticated={onAuthenticated} />);

    expect(screen.getByLabelText("Username")).toHaveValue("admin");
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "temporary-test-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith("admin", "temporary-test-password");
      expect(onAuthenticated).toHaveBeenCalledWith(authenticatedUser);
    });
  });

  it("keeps the user on the form and announces an authentication error", async () => {
    loginMock.mockRejectedValue(new Error("Invalid username or password."));
    render(<LoginScreen onAuthenticated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "incorrect-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid username or password.",
    );
    expect(screen.getByLabelText("Password")).toHaveValue("incorrect-password");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});

