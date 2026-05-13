import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

interface AppErrorBoundaryProps {
  children: ReactNode;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    errorMessage: "",
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Unhandled app error:", error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen bg-surface text-text-primary flex items-center justify-center px-6">
        <div className="max-w-xl w-full bg-panel border border-danger/30 rounded-xl p-6">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-text-secondary mt-2">
            The app hit an unexpected error. You can reload to recover.
          </p>
          <pre className="mt-4 text-xs text-danger bg-danger-light rounded-md p-3 whitespace-pre-wrap break-words">
            {this.state.errorMessage || "Unknown error"}
          </pre>
          <button
            onClick={this.handleReload}
            className="mt-4 px-4 py-2 rounded-md text-sm font-semibold bg-text-primary text-panel hover:bg-accent transition-colors"
          >
            Reload App
          </button>
        </div>
      </div>
    );
  }
}
