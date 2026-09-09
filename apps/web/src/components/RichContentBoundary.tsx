import { Component, Suspense, type ReactNode } from "react";

interface RichContentBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

/** Keeps readable task content available when an optional renderer cannot load. */
export class RichContentBoundary extends Component<
  RichContentBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return this.props.fallback;

    return (
      <Suspense fallback={this.props.fallback}>
        {this.props.children}
      </Suspense>
    );
  }
}
