import { initializeLayoutPreferences } from "./layoutPreferences";
import { initializeShortcutPreferences } from "./shortcutPreferences";
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/vendor.css";
import App from "./App";
import { OverlayScrollbarLayer } from "./components/OverlayScrollbarLayer";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <pre
          style={{
            color: "#ff9a9a",
            padding: 20,
            whiteSpace: "pre-wrap",
            fontFamily: "monospace",
          }}
        >
          {this.state.error.message}
          {"\n\n"}
          {this.state.error.stack}
        </pre>
      );
    }
    return this.props.children;
  }
}

initializeLayoutPreferences();
initializeShortcutPreferences();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
      <OverlayScrollbarLayer />
    </ErrorBoundary>
  </React.StrictMode>,
);
