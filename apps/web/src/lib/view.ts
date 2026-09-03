export type AppView =
  | "workspace"
  | "projects"
  | "reviews"
  | "artifacts"
  | "agents"
  | "providers"
  | "environments"
  | "capabilities"
  | "team"
  | "usage"
  | "billing"
  | "audit"
  | "platform";

export type OperationsViewId = Extract<
  AppView,
  "reviews" | "agents" | "environments" | "capabilities"
>;
