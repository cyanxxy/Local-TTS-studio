import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

interface SurfaceErrorBoundaryProps {
  /** What failed, as the fallback names it, e.g. "The Reader". */
  name: string;
  /** A change to any of these (say, the page) clears the error and tries again. */
  resetKeys: readonly unknown[];
  /** Classes for the fallback card, e.g. to float it where the surface was. */
  className?: string;
  /** Offers a way out instead of retrying, e.g. closing a dialog. */
  onDismiss?: () => void;
  children: ReactNode;
}

interface SurfaceErrorBoundaryState {
  error: unknown;
  /** Bumped on every retry. */
  attempt: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameKeys(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((key, index) => Object.is(key, right[index]));
}

/**
 * Contains a failure to one surface. The rest of the app, and whatever Studio
 * holds in memory, keeps working; the root `AppErrorBoundary` stays the last
 * resort. Try again remounts the surface, which for a code-split surface also
 * imports its chunk again (see `lazyWithRetry`).
 */
export class SurfaceErrorBoundary extends Component<SurfaceErrorBoundaryProps, SurfaceErrorBoundaryState> {
  state: SurfaceErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<SurfaceErrorBoundaryState> {
    return { error: error ?? new Error("Unknown error") };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`${this.props.name} failed:`, error, errorInfo.componentStack);
  }

  componentDidUpdate(previous: SurfaceErrorBoundaryProps) {
    if (this.state.error !== null && !sameKeys(previous.resetKeys, this.props.resetKeys)) this.retry();
  }

  private retry = () => {
    this.setState(({ attempt }) => ({ error: null, attempt: attempt + 1 }));
  };

  render() {
    const { error, attempt } = this.state;
    // Keyed by attempt, so Try again remounts the surface from scratch.
    if (error === null) return <Fragment key={attempt}>{this.props.children}</Fragment>;

    const { name, className = "", onDismiss } = this.props;
    return (
      <div role="alert" className={`surface rounded-[22px] border border-danger/30 p-5 sm:p-6 ${className}`}>
        <h2 className="text-lg font-semibold text-text-primary">{name} could not be shown</h2>
        <p className="mt-2 text-sm text-text-secondary">
          The rest of Open TTS still works. Try again, or reload the app if this keeps happening.
        </p>
        <pre className="mt-3 whitespace-pre-wrap break-words rounded-md bg-danger-light p-3 text-xs text-danger">
          {errorMessage(error) || "Unknown error"}
        </pre>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={this.retry}
            className="rounded-full bg-text-primary px-4 py-2 text-sm font-semibold text-panel transition-colors hover:bg-accent"
          >
            Try again
          </button>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="glass-control rounded-full px-4 py-2 text-sm font-semibold text-text-secondary hover:text-text-primary"
            >
              Close
            </button>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="glass-control rounded-full px-4 py-2 text-sm font-semibold text-text-secondary hover:text-text-primary"
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
