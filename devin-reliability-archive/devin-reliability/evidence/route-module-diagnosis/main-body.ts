const React = __vite__cjsImport0_react;const ReactDOM = __vite__cjsImport1_reactDom_client;const _jsxDEV = __vite__cjsImport10_react_jsxDevRuntime["jsxDEV"];import __vite__cjsImport0_react from "/node_modules/.vite/deps/react.js?v=1556ae44";
import __vite__cjsImport1_reactDom_client from "/node_modules/.vite/deps/react-dom_client.js?v=1556ae44";
import { RouterProvider } from "/node_modules/.vite/deps/@tanstack_react-router.js?v=1556ae44";
import "/@fs/Users/user/synara/node_modules/.bun/@fontsource-variable+jetbrains-mono@5.2.8/node_modules/@fontsource-variable/jetbrains-mono/index.css";
import "/src/index.css";
import { appHistory } from "/src/appNavigation.ts";
import { getRouter } from "/src/router.ts";
import { APP_DISPLAY_NAME } from "/src/branding.ts";
import { isElectron } from "/src/env.ts";
import { isMacPlatform } from "/src/lib/utils.ts";
var _jsxFileName = "/Users/user/.synara/worktrees/devin-tool-idle-budget-clean/apps/web/src/main.tsx";
import __vite__cjsImport10_react_jsxDevRuntime from "/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1556ae44";
const router = getRouter(appHistory);
document.title = APP_DISPLAY_NAME;
if (isElectron) {
	document.documentElement.dataset.runtime = "electron";
	// macOS desktop windows are transparent vibrancy windows (see getWindowMaterialOptions
	// in apps/desktop), and Chromium cannot render `backdrop-filter` inside transparent
	// windows — frosted surfaces must fall back to a more opaque fill (see index.css).
	if (isMacPlatform(navigator.platform)) {
		document.documentElement.dataset.windowTransparent = "true";
	}
}
ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ _jsxDEV(React.StrictMode, { children: /* @__PURE__ */ _jsxDEV(RouterProvider, { router }, void 0, false, {
	fileName: _jsxFileName,
	lineNumber: 23,
	columnNumber: 5
}, this) }, void 0, false, {
	fileName: _jsxFileName,
	lineNumber: 22,
	columnNumber: 76
}, this));

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxXQUFXO0FBQ2xCLE9BQU8sY0FBYztBQUNyQixTQUFTLHNCQUFzQjtBQUUvQixPQUFPO0FBQ1AsT0FBTztBQUVQLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMscUJBQXFCOzs7QUFFOUIsTUFBTSxTQUFTLFVBQVUsVUFBVTtBQUVuQyxTQUFTLFFBQVE7QUFFakIsSUFBSSxZQUFZO0NBQ2QsU0FBUyxnQkFBZ0IsUUFBUSxVQUFVOzs7O0NBSTNDLElBQUksY0FBYyxVQUFVLFFBQVEsR0FBRztFQUNyQyxTQUFTLGdCQUFnQixRQUFRLG9CQUFvQjtDQUN2RDtBQUNGO0FBRUEsU0FBUyxXQUFXLFNBQVMsZUFBZSxNQUFNLENBQWdCLENBQUMsQ0FBQyxPQUNsRSx3QkFBQyxNQUFNLFlBQVAsWUFDRSx3QkFBQyxnQkFBRCxFQUF3QixPQUFPOzs7O1NBQ2Y7Ozs7UUFDcEIiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbIm1haW4udHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tIFwicmVhY3RcIjtcbmltcG9ydCBSZWFjdERPTSBmcm9tIFwicmVhY3QtZG9tL2NsaWVudFwiO1xuaW1wb3J0IHsgUm91dGVyUHJvdmlkZXIgfSBmcm9tIFwiQHRhbnN0YWNrL3JlYWN0LXJvdXRlclwiO1xuXG5pbXBvcnQgXCJAZm9udHNvdXJjZS12YXJpYWJsZS9qZXRicmFpbnMtbW9ub1wiO1xuaW1wb3J0IFwiLi9pbmRleC5jc3NcIjtcblxuaW1wb3J0IHsgYXBwSGlzdG9yeSB9IGZyb20gXCIuL2FwcE5hdmlnYXRpb25cIjtcbmltcG9ydCB7IGdldFJvdXRlciB9IGZyb20gXCIuL3JvdXRlclwiO1xuaW1wb3J0IHsgQVBQX0RJU1BMQVlfTkFNRSB9IGZyb20gXCIuL2JyYW5kaW5nXCI7XG5pbXBvcnQgeyBpc0VsZWN0cm9uIH0gZnJvbSBcIi4vZW52XCI7XG5pbXBvcnQgeyBpc01hY1BsYXRmb3JtIH0gZnJvbSBcIi4vbGliL3V0aWxzXCI7XG5cbmNvbnN0IHJvdXRlciA9IGdldFJvdXRlcihhcHBIaXN0b3J5KTtcblxuZG9jdW1lbnQudGl0bGUgPSBBUFBfRElTUExBWV9OQU1FO1xuXG5pZiAoaXNFbGVjdHJvbikge1xuICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC5ydW50aW1lID0gXCJlbGVjdHJvblwiO1xuICAvLyBtYWNPUyBkZXNrdG9wIHdpbmRvd3MgYXJlIHRyYW5zcGFyZW50IHZpYnJhbmN5IHdpbmRvd3MgKHNlZSBnZXRXaW5kb3dNYXRlcmlhbE9wdGlvbnNcbiAgLy8gaW4gYXBwcy9kZXNrdG9wKSwgYW5kIENocm9taXVtIGNhbm5vdCByZW5kZXIgYGJhY2tkcm9wLWZpbHRlcmAgaW5zaWRlIHRyYW5zcGFyZW50XG4gIC8vIHdpbmRvd3Mg4oCUIGZyb3N0ZWQgc3VyZmFjZXMgbXVzdCBmYWxsIGJhY2sgdG8gYSBtb3JlIG9wYXF1ZSBmaWxsIChzZWUgaW5kZXguY3NzKS5cbiAgaWYgKGlzTWFjUGxhdGZvcm0obmF2aWdhdG9yLnBsYXRmb3JtKSkge1xuICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LndpbmRvd1RyYW5zcGFyZW50ID0gXCJ0cnVlXCI7XG4gIH1cbn1cblxuUmVhY3RET00uY3JlYXRlUm9vdChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikgYXMgSFRNTEVsZW1lbnQpLnJlbmRlcihcbiAgPFJlYWN0LlN0cmljdE1vZGU+XG4gICAgPFJvdXRlclByb3ZpZGVyIHJvdXRlcj17cm91dGVyfSAvPlxuICA8L1JlYWN0LlN0cmljdE1vZGU+LFxuKTtcbiJdLCJmaWxlIjoiL1VzZXJzL3VzZXIvLnN5bmFyYS93b3JrdHJlZXMvZGV2aW4tdG9vbC1pZGxlLWJ1ZGdldC1jbGVhbi9hcHBzL3dlYi9zcmMvbWFpbi50c3gifQ==