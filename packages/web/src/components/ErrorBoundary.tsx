import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; resetKey?: string; testId?: string };
type State = { crashed: boolean; resetKey: string | undefined };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { crashed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { crashed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown) {
    console.error("页面渲染出错", error);
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <main className="crash-page" role="alert" data-testid={this.props.testId ?? "crash-page"}>
        <p className="crash-title">页面出错了</p>
        <p className="crash-text">这一块没画出来，重新加载一下通常就好。</p>
        <button
          type="button"
          className="primary-button"
          data-testid="crash-reload"
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </main>
    );
  }
}
