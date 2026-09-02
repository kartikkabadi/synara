import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/src/routes/_chat.$threadId.tsx?tsr-split=component&readiness=final");const _c = __vite__cjsImport0_react_compilerRuntime["c"];const useEffect = __vite__cjsImport3_react["useEffect"]; const useRef = __vite__cjsImport3_react["useRef"]; const useState = __vite__cjsImport3_react["useState"];const _jsxDEV = __vite__cjsImport16_react_jsxDevRuntime["jsxDEV"];import __vite__cjsImport0_react_compilerRuntime from "/node_modules/.vite/deps/react_compiler-runtime.js?v=1556ae44";
// FILE: _chat.$threadId.tsx
// Purpose: Resolve the active thread route into either a single chat surface or a persisted split view.
// Layer: Route container
import { ThreadId } from "/@fs/Users/user/.synara/worktrees/devin-tool-idle-budget-clean/packages/contracts/src/index.ts";
import { useNavigate } from "/node_modules/.vite/deps/@tanstack_react-router.js?v=1556ae44";
import __vite__cjsImport3_react from "/node_modules/.vite/deps/react.js?v=1556ae44";
import { shouldHoldMissingThreadRouteFallback, shouldStartMissingThreadRouteRecovery } from "/src/chatRouteRestore.ts";
import { refreshEmptyRouteRestoreSnapshot, waitForEmptyRouteRestoreFallbackDelay } from "/src/chatRouteRecovery.ts";
import { useComposerDraftStore } from "/src/composerDraftStore.ts";
import { stripDiffSearchParams } from "/src/diffRouteSearch.ts";
import { readNativeApi } from "/src/nativeApi.ts";
import { isSplitRoute } from "/src/splitViewRoute.ts";
import { selectSplitView, useSplitViewStore } from "/src/splitViewStore.ts";
import { useStore } from "/src/store.ts";
import { createThreadExistsSelector, createThreadProjectIdSelector } from "/src/storeSelectors.ts";
import { SingleChatSurface } from "/src/components/chat/SingleChatSurface.tsx";
import { SplitChatSurface } from "/src/components/chat/SplitChatSurface.tsx";
import { resolveSingleProjectId } from "/src/routes/-chatThreadRoute.logic.ts";
var _jsxFileName = "/Users/user/.synara/worktrees/devin-tool-idle-budget-clean/apps/web/src/routes/_chat.$threadId.tsx?tsr-split=component&readiness=final";
import __vite__cjsImport16_react_jsxDevRuntime from "/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1556ae44";
var _s = $RefreshSig$();
function ChatThreadRouteView() {
	_s();
	const $ = _c(40);
	if ($[0] !== "dde90e1785f4418f04f9a0cc1d9d04c19bff92a2d2411524b14d8c4387af141b") {
		for (let $i = 0; $i < 40; $i += 1) {
			$[$i] = Symbol.for("react.memo_cache_sentinel");
		}
		$[0] = "dde90e1785f4418f04f9a0cc1d9d04c19bff92a2d2411524b14d8c4387af141b";
	}
	const threadsHydrated = useStore(_temp);
	const hasKnownServerThreads = useStore(_temp2);
	let t0;
	if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { select: _temp3 };
		$[1] = t0;
	} else {
		t0 = $[1];
	}
	const threadId = Route.useParams(t0);
	const search = Route.useSearch();
	let t1;
	if ($[2] !== threadId) {
		t1 = createThreadProjectIdSelector(threadId);
		$[2] = threadId;
		$[3] = t1;
	} else {
		t1 = $[3];
	}
	const threadProjectIdSelector = t1;
	let t2;
	if ($[4] !== threadId) {
		t2 = createThreadExistsSelector(threadId);
		$[4] = threadId;
		$[5] = t2;
	} else {
		t2 = $[5];
	}
	const threadExistsSelector = t2;
	const threadProjectId = useStore(threadProjectIdSelector);
	const threadExists = useStore(threadExistsSelector);
	let t3;
	if ($[6] !== threadId) {
		t3 = (store_1) => store_1.draftThreadsByThreadId[threadId] ?? null;
		$[6] = threadId;
		$[7] = t3;
	} else {
		t3 = $[7];
	}
	const draftThreadState = useComposerDraftStore(t3);
	const draftThreadExists = draftThreadState !== null;
	const routeThreadExists = threadExists || draftThreadExists;
	const t4 = search.splitViewId ?? null;
	let t5;
	if ($[8] !== t4) {
		t5 = selectSplitView(t4);
		$[8] = t4;
		$[9] = t5;
	} else {
		t5 = $[9];
	}
	const splitView = useSplitViewStore(t5);
	const splitViewsHydrated = useSplitViewStore(_temp4);
	const t6 = draftThreadState?.projectId ?? null;
	let t7;
	if ($[10] !== t6 || $[11] !== threadProjectId) {
		t7 = resolveSingleProjectId({
			threadProjectId,
			draftProjectId: t6
		});
		$[10] = t6;
		$[11] = threadProjectId;
		$[12] = t7;
	} else {
		t7 = $[12];
	}
	const activeProjectId = t7;
	const navigate = useNavigate();
	const [missingThreadRecoveryState, setMissingThreadRecoveryState] = useState("idle");
	const mountedRef = useRef(true);
	const missingThreadRecoveryRunRef = useRef(0);
	const recoveryStartedRef = useRef(false);
	let t8;
	let t9;
	if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = () => () => {
			mountedRef.current = false;
		};
		t9 = [];
		$[13] = t8;
		$[14] = t9;
	} else {
		t8 = $[13];
		t9 = $[14];
	}
	useEffect(t8, t9);
	let t10;
	if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
		t10 = () => {
			missingThreadRecoveryRunRef.current = missingThreadRecoveryRunRef.current + 1;
			recoveryStartedRef.current = false;
			const timer = window.setTimeout(() => setMissingThreadRecoveryState("idle"), 0);
			return () => window.clearTimeout(timer);
		};
		$[15] = t10;
	} else {
		t10 = $[15];
	}
	let t11;
	if ($[16] !== threadId) {
		t11 = [threadId];
		$[16] = threadId;
		$[17] = t11;
	} else {
		t11 = $[17];
	}
	useEffect(t10, t11);
	let t12;
	let t13;
	if ($[18] !== missingThreadRecoveryState || $[19] !== routeThreadExists) {
		t12 = () => {
			if (routeThreadExists && missingThreadRecoveryState !== "idle") {
				missingThreadRecoveryRunRef.current = missingThreadRecoveryRunRef.current + 1;
				recoveryStartedRef.current = false;
				const timer_0 = window.setTimeout(() => setMissingThreadRecoveryState("idle"), 0);
				return () => window.clearTimeout(timer_0);
			}
		};
		t13 = [missingThreadRecoveryState, routeThreadExists];
		$[18] = missingThreadRecoveryState;
		$[19] = routeThreadExists;
		$[20] = t12;
		$[21] = t13;
	} else {
		t12 = $[20];
		t13 = $[21];
	}
	useEffect(t12, t13);
	let t14;
	let t15;
	if ($[22] !== hasKnownServerThreads || $[23] !== missingThreadRecoveryState || $[24] !== navigate || $[25] !== routeThreadExists || $[26] !== search || $[27] !== splitView || $[28] !== splitViewsHydrated || $[29] !== threadId || $[30] !== threadsHydrated) {
		t14 = () => {
			if (!threadsHydrated || !splitViewsHydrated) {
				return;
			}
			if (!routeThreadExists) {
				if (shouldStartMissingThreadRouteRecovery({
					hasKnownServerThreads,
					recoveryState: missingThreadRecoveryState,
					routeThreadExists
				}) && !recoveryStartedRef.current) {
					recoveryStartedRef.current = true;
					const recoveryRun = missingThreadRecoveryRunRef.current = missingThreadRecoveryRunRef.current + 1;
					const pendingTimer = window.setTimeout(() => {
						if (missingThreadRecoveryRunRef.current === recoveryRun) {
							setMissingThreadRecoveryState("pending");
						}
					}, 0);
					Promise.all([refreshEmptyRouteRestoreSnapshot(readNativeApi()).catch(_temp5), waitForEmptyRouteRestoreFallbackDelay()]).finally(() => {
						window.clearTimeout(pendingTimer);
						if (mountedRef.current && missingThreadRecoveryRunRef.current === recoveryRun) {
							setMissingThreadRecoveryState("done");
						}
					});
					return;
				}
				if (shouldHoldMissingThreadRouteFallback({
					hasKnownServerThreads,
					recoveryState: missingThreadRecoveryState,
					routeThreadExists
				})) {
					return;
				}
			}
			if (isSplitRoute(search)) {
				if (!splitView) {
					navigate({
						to: "/$threadId",
						params: { threadId },
						replace: true,
						search: _temp6
					});
				}
				return;
			}
			if (!routeThreadExists) {
				navigate({
					to: "/",
					replace: true
				});
			}
		};
		t15 = [
			hasKnownServerThreads,
			missingThreadRecoveryState,
			navigate,
			routeThreadExists,
			search,
			splitView,
			splitViewsHydrated,
			threadId,
			threadsHydrated
		];
		$[22] = hasKnownServerThreads;
		$[23] = missingThreadRecoveryState;
		$[24] = navigate;
		$[25] = routeThreadExists;
		$[26] = search;
		$[27] = splitView;
		$[28] = splitViewsHydrated;
		$[29] = threadId;
		$[30] = threadsHydrated;
		$[31] = t14;
		$[32] = t15;
	} else {
		t14 = $[31];
		t15 = $[32];
	}
	useEffect(t14, t15);
	if (!threadsHydrated || !splitViewsHydrated || shouldHoldMissingThreadRouteFallback({
		hasKnownServerThreads,
		recoveryState: missingThreadRecoveryState,
		routeThreadExists
	})) {
		return null;
	}
	if (splitView && search.splitViewId) {
		let t16;
		if ($[33] !== search.splitViewId || $[34] !== threadId) {
			t16 = /* @__PURE__ */ _jsxDEV(SplitChatSurface, {
				splitViewId: search.splitViewId,
				routeThreadId: threadId
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 242,
				columnNumber: 13
			}, this);
			$[33] = search.splitViewId;
			$[34] = threadId;
			$[35] = t16;
		} else {
			t16 = $[35];
		}
		return t16;
	}
	if (!routeThreadExists) {
		return null;
	}
	let t16;
	if ($[36] !== activeProjectId || $[37] !== search || $[38] !== threadId) {
		t16 = /* @__PURE__ */ _jsxDEV(SingleChatSurface, {
			threadId,
			search,
			projectId: activeProjectId
		}, void 0, false, {
			fileName: _jsxFileName,
			lineNumber: 256,
			columnNumber: 11
		}, this);
		$[36] = activeProjectId;
		$[37] = search;
		$[38] = threadId;
		$[39] = t16;
	} else {
		t16 = $[39];
	}
	return t16;
}
_s(ChatThreadRouteView, "Ee2lZWuyjzUGckk2B8107cYMvuU=", false, function() {
	return [
		useStore,
		useStore,
		Route.useParams,
		Route.useSearch,
		useStore,
		useStore,
		useComposerDraftStore,
		useSplitViewStore,
		useSplitViewStore,
		useNavigate
	];
});
_c2 = ChatThreadRouteView;
function _temp6(previous) {
	return {
		...stripDiffSearchParams(previous),
		splitViewId: undefined
	};
}
function _temp5() {
	return false;
}
function _temp4(store_2) {
	return store_2.hasHydrated;
}
function _temp3(params) {
	return ThreadId.makeUnsafe(params.threadId);
}
function _temp2(store_0) {
	return (store_0.threadIds?.length ?? 0) > 0;
}
function _temp(store) {
	return store.threadsHydrated;
}
import { Route } from "/src/routes/_chat.$threadId.tsx";
export { ChatThreadRouteView as component };
var _c2;
$RefreshReg$(_c2, "ChatThreadRouteView");
import * as RefreshRuntime from "/@react-refresh";
const inWebWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
import * as __vite_react_currentExports from "/src/routes/_chat.$threadId.tsx?tsr-split=component&readiness=final";
if (import.meta.hot && !inWebWorker) {
  if (!window.$RefreshReg$) {
    throw new Error(
      "@vitejs/plugin-react can't detect preamble. Something is wrong."
    );
  }

  const currentExports = __vite_react_currentExports;
  queueMicrotask(() => {
    RefreshRuntime.registerExportsForReactRefresh("/Users/user/.synara/worktrees/devin-tool-idle-budget-clean/apps/web/src/routes/_chat.$threadId.tsx?tsr-split=component&readiness=final", currentExports);
    import.meta.hot.accept((nextExports) => {
      if (!nextExports) return;
      const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate("/Users/user/.synara/worktrees/devin-tool-idle-budget-clean/apps/web/src/routes/_chat.$threadId.tsx?tsr-split=component&readiness=final", currentExports, nextExports);
      if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
    });
  });
}
function $RefreshReg$(type, id) { return RefreshRuntime.register(type, "/Users/user/.synara/worktrees/devin-tool-idle-budget-clean/apps/web/src/routes/_chat.$threadId.tsx?tsr-split=component&readiness=final" + ' ' + id); }
function $RefreshSig$() { return RefreshRuntime.createSignatureFunctionForTransform(); }

//# sourceMappingURL=data:application/json;base64,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QUNBVDtHQUNBUDtHQUNBZTtHQUNBTDtHQUNBZjtHQUNBYztFQUFlO0VBQ2hCO0VBQUE7RUFBQTtFQUFBO0VBQUE7RUFBQTtFQUFBO0VBQUE7RUFBQTtFQUFBO0VBQUE7Q0FBQTtFQUFBO0VBQUE7Q0FBQTtDQTNFRHBDLFVBQVUsS0FpRVAsR0FVRjtDQUVELElBQ0UsQ0FBQ29DLG1CQUFELENBQ0NDLHNCQUNEbEMscUNBQXFDO0VBQUE7RUFBQSxlQUVwQmdDO0VBQTBCO0NBRTNDLENBQUMsR0FBQztFQUFBLE9BRUs7Q0FBSTtDQUdiLElBQUlPLGFBQWFmLE9BQU0sYUFBWTtFQUFBO0VBQUE7R0FDMUIsOEJBQUMsa0JBQUQ7SUFBK0JBLG9CQUFNO0lBQTZCTDtHQUFROzs7OztHQUFJO0dBQUE7R0FBQTtFQUFBO0dBQUE7RUFBQTtFQUFBLE9BQTlFO0NBQThFO0NBR3ZGLElBQUksQ0FBQ1ksbUJBQWlCO0VBQUEsT0FDYjtDQUFJO0NBQ2I7Q0FBQTtFQUVPLDhCQUFDLG1CQUFEO0dBQTZCWjtHQUFrQks7R0FBbUJtQjtFQUFlOzs7OztFQUFJO0VBQUE7RUFBQTtFQUFBO0NBQUE7RUFBQTtDQUFBO0NBQUEsT0FBckY7QUFBcUY7Ozs7Ozs7Ozs7Ozs7Ozs7QUE5SjlGO0NBQUEsT0FrSGlDO0VBQUEsR0FDbEJ0QyxzQkFBc0JvQyxRQUFRO0VBQUMsYUFDckJHO0NBQ2Y7QUFBQztBQXJIWDtDQUFBLE9Bc0Z3RTtBQUFLO0FBdEY3RTtDQUFBLE9BbUIwRDVCLFFBQUs7QUFBWTtBQW5CM0U7Q0FBQSxPQUl3QnJCLFNBQVEsV0FBWXNCLE9BQU0sUUFBUztBQUFBO0FBSjNEO0NBQUEsUUFFcURELFFBQUssV0FBa0IsVUFBdkJBLEtBQWdDO0FBQUM7QUFGdEY7Q0FBQSxPQUM4Q0EsTUFBSztBQUFnQjtBQThKbEUsU0FBQUUsYUFBQTtBQUFBLFNBQUEyQix1QkFBQUMiLCJuYW1lcyI6WyJUaHJlYWRJZCIsInVzZU5hdmlnYXRlIiwidXNlRWZmZWN0IiwidXNlUmVmIiwidXNlU3RhdGUiLCJzaG91bGRIb2xkTWlzc2luZ1RocmVhZFJvdXRlRmFsbGJhY2siLCJzaG91bGRTdGFydE1pc3NpbmdUaHJlYWRSb3V0ZVJlY292ZXJ5IiwicmVmcmVzaEVtcHR5Um91dGVSZXN0b3JlU25hcHNob3QiLCJ3YWl0Rm9yRW1wdHlSb3V0ZVJlc3RvcmVGYWxsYmFja0RlbGF5IiwidXNlQ29tcG9zZXJEcmFmdFN0b3JlIiwic3RyaXBEaWZmU2VhcmNoUGFyYW1zIiwicmVhZE5hdGl2ZUFwaSIsImlzU3BsaXRSb3V0ZSIsInNlbGVjdFNwbGl0VmlldyIsInVzZVNwbGl0Vmlld1N0b3JlIiwidXNlU3RvcmUiLCJjcmVhdGVUaHJlYWRFeGlzdHNTZWxlY3RvciIsImNyZWF0ZVRocmVhZFByb2plY3RJZFNlbGVjdG9yIiwiU2luZ2xlQ2hhdFN1cmZhY2UiLCJTcGxpdENoYXRTdXJmYWNlIiwicmVzb2x2ZVNpbmdsZVByb2plY3RJZCIsInN0b3JlIiwicGFyYW1zIiwiUm91dGUiLCJ0aHJlYWRJZCIsInRocmVhZFByb2plY3RJZFNlbGVjdG9yIiwidGhyZWFkRXhpc3RzU2VsZWN0b3IiLCJkcmFmdFRocmVhZFN0YXRlIiwidGhyZWFkRXhpc3RzIiwic2VhcmNoIiwibW91bnRlZFJlZiIsIm1pc3NpbmdUaHJlYWRSZWNvdmVyeVJ1blJlZiIsInJlY292ZXJ5U3RhcnRlZFJlZiIsIndpbmRvdyIsInNldE1pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlIiwidGltZXIiLCJyb3V0ZVRocmVhZEV4aXN0cyIsIm1pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlIiwidGhyZWFkc0h5ZHJhdGVkIiwic3BsaXRWaWV3c0h5ZHJhdGVkIiwiY3VycmVudCIsInJlY292ZXJ5UnVuIiwiUHJvbWlzZSIsInBlbmRpbmdUaW1lciIsInNwbGl0VmlldyIsIm5hdmlnYXRlIiwicHJldmlvdXMiLCJoYXNLbm93blNlcnZlclRocmVhZHMiLCJhY3RpdmVQcm9qZWN0SWQiLCJ1bmRlZmluZWQiLCJDaGF0VGhyZWFkUm91dGVWaWV3IiwiY29tcG9uZW50Il0sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbIl9jaGF0LiR0aHJlYWRJZC50c3g/dHNyLXNwbGl0PWNvbXBvbmVudCZyZWFkaW5lc3M9ZmluYWwiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gRklMRTogX2NoYXQuJHRocmVhZElkLnRzeFxuLy8gUHVycG9zZTogUmVzb2x2ZSB0aGUgYWN0aXZlIHRocmVhZCByb3V0ZSBpbnRvIGVpdGhlciBhIHNpbmdsZSBjaGF0IHN1cmZhY2Ugb3IgYSBwZXJzaXN0ZWQgc3BsaXQgdmlldy5cbi8vIExheWVyOiBSb3V0ZSBjb250YWluZXJcblxuaW1wb3J0IHsgdHlwZSBQcm9qZWN0SWQsIFRocmVhZElkIH0gZnJvbSBcIkBzeW5hcmEvY29udHJhY3RzXCI7XG5pbXBvcnQgeyBjcmVhdGVGaWxlUm91dGUsIHVzZU5hdmlnYXRlIH0gZnJvbSBcIkB0YW5zdGFjay9yZWFjdC1yb3V0ZXJcIjtcbmltcG9ydCB7IHVzZUVmZmVjdCwgdXNlTWVtbywgdXNlUmVmLCB1c2VTdGF0ZSB9IGZyb20gXCJyZWFjdFwiO1xuXG5pbXBvcnQge1xuICB0eXBlIEVtcHR5Um91dGVSZXN0b3JlUmVjb3ZlcnlTdGF0ZSxcbiAgc2hvdWxkSG9sZE1pc3NpbmdUaHJlYWRSb3V0ZUZhbGxiYWNrLFxuICBzaG91bGRTdGFydE1pc3NpbmdUaHJlYWRSb3V0ZVJlY292ZXJ5LFxufSBmcm9tIFwiLi4vY2hhdFJvdXRlUmVzdG9yZVwiO1xuaW1wb3J0IHtcbiAgcmVmcmVzaEVtcHR5Um91dGVSZXN0b3JlU25hcHNob3QsXG4gIHdhaXRGb3JFbXB0eVJvdXRlUmVzdG9yZUZhbGxiYWNrRGVsYXksXG59IGZyb20gXCIuLi9jaGF0Um91dGVSZWNvdmVyeVwiO1xuaW1wb3J0IHsgdXNlQ29tcG9zZXJEcmFmdFN0b3JlIH0gZnJvbSBcIi4uL2NvbXBvc2VyRHJhZnRTdG9yZVwiO1xuaW1wb3J0IHsgcGFyc2VEaWZmUm91dGVTZWFyY2gsIHN0cmlwRGlmZlNlYXJjaFBhcmFtcyB9IGZyb20gXCIuLi9kaWZmUm91dGVTZWFyY2hcIjtcbmltcG9ydCB7IHJlYWROYXRpdmVBcGkgfSBmcm9tIFwiLi4vbmF0aXZlQXBpXCI7XG5pbXBvcnQgeyBpc1NwbGl0Um91dGUgfSBmcm9tIFwiLi4vc3BsaXRWaWV3Um91dGVcIjtcbmltcG9ydCB7IHNlbGVjdFNwbGl0VmlldywgdXNlU3BsaXRWaWV3U3RvcmUgfSBmcm9tIFwiLi4vc3BsaXRWaWV3U3RvcmVcIjtcbmltcG9ydCB7IHVzZVN0b3JlIH0gZnJvbSBcIi4uL3N0b3JlXCI7XG5pbXBvcnQgeyBjcmVhdGVUaHJlYWRFeGlzdHNTZWxlY3RvciwgY3JlYXRlVGhyZWFkUHJvamVjdElkU2VsZWN0b3IgfSBmcm9tIFwiLi4vc3RvcmVTZWxlY3RvcnNcIjtcbmltcG9ydCB7IFNpbmdsZUNoYXRTdXJmYWNlIH0gZnJvbSBcIi4uL2NvbXBvbmVudHMvY2hhdC9TaW5nbGVDaGF0U3VyZmFjZVwiO1xuaW1wb3J0IHsgU3BsaXRDaGF0U3VyZmFjZSB9IGZyb20gXCIuLi9jb21wb25lbnRzL2NoYXQvU3BsaXRDaGF0U3VyZmFjZVwiO1xuaW1wb3J0IHsgcmVzb2x2ZVNpbmdsZVByb2plY3RJZCB9IGZyb20gXCIuLy1jaGF0VGhyZWFkUm91dGUubG9naWNcIjtcblxuZnVuY3Rpb24gQ2hhdFRocmVhZFJvdXRlVmlldygpIHtcbiAgY29uc3QgdGhyZWFkc0h5ZHJhdGVkID0gdXNlU3RvcmUoKHN0b3JlKSA9PiBzdG9yZS50aHJlYWRzSHlkcmF0ZWQpO1xuICBjb25zdCBoYXNLbm93blNlcnZlclRocmVhZHMgPSB1c2VTdG9yZSgoc3RvcmUpID0+IChzdG9yZS50aHJlYWRJZHM/Lmxlbmd0aCA/PyAwKSA+IDApO1xuICBjb25zdCB0aHJlYWRJZCA9IFJvdXRlLnVzZVBhcmFtcyh7XG4gICAgc2VsZWN0OiAocGFyYW1zKSA9PiBUaHJlYWRJZC5tYWtlVW5zYWZlKHBhcmFtcy50aHJlYWRJZCksXG4gIH0pO1xuICBjb25zdCBzZWFyY2ggPSBSb3V0ZS51c2VTZWFyY2goKTtcbiAgY29uc3QgdGhyZWFkUHJvamVjdElkU2VsZWN0b3IgPSBjcmVhdGVUaHJlYWRQcm9qZWN0SWRTZWxlY3Rvcih0aHJlYWRJZCk7XG4gIGNvbnN0IHRocmVhZEV4aXN0c1NlbGVjdG9yID0gY3JlYXRlVGhyZWFkRXhpc3RzU2VsZWN0b3IodGhyZWFkSWQpO1xuICBjb25zdCB0aHJlYWRQcm9qZWN0SWQ6IFByb2plY3RJZCB8IG51bGwgPSB1c2VTdG9yZSh0aHJlYWRQcm9qZWN0SWRTZWxlY3Rvcik7XG4gIGNvbnN0IHRocmVhZEV4aXN0cyA9IHVzZVN0b3JlKHRocmVhZEV4aXN0c1NlbGVjdG9yKTtcbiAgY29uc3QgZHJhZnRUaHJlYWRTdGF0ZSA9IHVzZUNvbXBvc2VyRHJhZnRTdG9yZShcbiAgICAoc3RvcmUpID0+IHN0b3JlLmRyYWZ0VGhyZWFkc0J5VGhyZWFkSWRbdGhyZWFkSWRdID8/IG51bGwsXG4gICk7XG4gIGNvbnN0IGRyYWZ0VGhyZWFkRXhpc3RzID0gZHJhZnRUaHJlYWRTdGF0ZSAhPT0gbnVsbDtcbiAgY29uc3Qgcm91dGVUaHJlYWRFeGlzdHMgPSB0aHJlYWRFeGlzdHMgfHwgZHJhZnRUaHJlYWRFeGlzdHM7XG4gIGNvbnN0IHNwbGl0VmlldyA9IHVzZVNwbGl0Vmlld1N0b3JlKFxuICAgIHVzZU1lbW8oKCkgPT4gc2VsZWN0U3BsaXRWaWV3KHNlYXJjaC5zcGxpdFZpZXdJZCA/PyBudWxsKSwgW3NlYXJjaC5zcGxpdFZpZXdJZF0pLFxuICApO1xuICBjb25zdCBzcGxpdFZpZXdzSHlkcmF0ZWQgPSB1c2VTcGxpdFZpZXdTdG9yZSgoc3RvcmUpID0+IHN0b3JlLmhhc0h5ZHJhdGVkKTtcbiAgY29uc3QgYWN0aXZlUHJvamVjdElkID0gcmVzb2x2ZVNpbmdsZVByb2plY3RJZCh7XG4gICAgdGhyZWFkUHJvamVjdElkLFxuICAgIGRyYWZ0UHJvamVjdElkOiBkcmFmdFRocmVhZFN0YXRlPy5wcm9qZWN0SWQgPz8gbnVsbCxcbiAgfSk7XG4gIGNvbnN0IG5hdmlnYXRlID0gdXNlTmF2aWdhdGUoKTtcbiAgY29uc3QgW21pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlLCBzZXRNaXNzaW5nVGhyZWFkUmVjb3ZlcnlTdGF0ZV0gPVxuICAgIHVzZVN0YXRlPEVtcHR5Um91dGVSZXN0b3JlUmVjb3ZlcnlTdGF0ZT4oXCJpZGxlXCIpO1xuICBjb25zdCBtb3VudGVkUmVmID0gdXNlUmVmKHRydWUpO1xuICBjb25zdCBtaXNzaW5nVGhyZWFkUmVjb3ZlcnlSdW5SZWYgPSB1c2VSZWYoMCk7XG4gIC8vIFN5bmNocm9ub3VzIHJlLWVudHJ5IGd1YXJkOiB0aGUgXCJwZW5kaW5nXCIgdHJhbnNpdGlvbiBiZWxvdyBpcyBkZWZlcnJlZCAoYXN5bmNcbiAgLy8gc2V0U3RhdGUpLCBzbyB0aGlzIHJlZiBrZWVwcyB0aGUgcmVjb3ZlcnkgZnJvbSBzdGFydGluZyB0d2ljZSBpbiB0aGUgaW50ZXJpbS5cbiAgLy8gSXQgaXMgY2xlYXJlZCBzeW5jaHJvbm91c2x5IHdoZW5ldmVyIGFuIGVwaXNvZGUgaXMgaW52YWxpZGF0ZWQgKG5ldyB0aHJlYWRcbiAgLy8gcm91dGUsIG9yIHRoZSB0aHJlYWQgYXBwZWFyaW5nKS5cbiAgY29uc3QgcmVjb3ZlcnlTdGFydGVkUmVmID0gdXNlUmVmKGZhbHNlKTtcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIHJldHVybiAoKSA9PiB7XG4gICAgICBtb3VudGVkUmVmLmN1cnJlbnQgPSBmYWxzZTtcbiAgICB9O1xuICB9LCBbXSk7XG5cbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICAvLyBJbnZhbGlkYXRlIGFueSBpbi1mbGlnaHQgcmVjb3ZlcnkgYW5kIHN0YXJ0IGEgZnJlc2ggZXBpc29kZSBmb3IgdGhlIG5ld1xuICAgIC8vIHRocmVhZCByb3V0ZS4gVGhlIHJ1biBidW1wICsgZ3VhcmQgcmVzZXQgYXJlIHN5bmNocm9ub3VzIChzbyBhIHN0YWxlIGFzeW5jXG4gICAgLy8gY29tcGxldGlvbiBjYW5ub3Qgc3RhbXAgXCJkb25lXCIpOyB0aGUgc3RhdGUgcmVzZXQgaXMgZGVmZXJyZWQgYXN5bmMgc2V0U3RhdGUuXG4gICAgbWlzc2luZ1RocmVhZFJlY292ZXJ5UnVuUmVmLmN1cnJlbnQgKz0gMTtcbiAgICByZWNvdmVyeVN0YXJ0ZWRSZWYuY3VycmVudCA9IGZhbHNlO1xuICAgIGNvbnN0IHRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4gc2V0TWlzc2luZ1RocmVhZFJlY292ZXJ5U3RhdGUoXCJpZGxlXCIpLCAwKTtcbiAgICByZXR1cm4gKCkgPT4gd2luZG93LmNsZWFyVGltZW91dCh0aW1lcik7XG4gIH0sIFt0aHJlYWRJZF0pO1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgaWYgKHJvdXRlVGhyZWFkRXhpc3RzICYmIG1pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlICE9PSBcImlkbGVcIikge1xuICAgICAgbWlzc2luZ1RocmVhZFJlY292ZXJ5UnVuUmVmLmN1cnJlbnQgKz0gMTtcbiAgICAgIHJlY292ZXJ5U3RhcnRlZFJlZi5jdXJyZW50ID0gZmFsc2U7XG4gICAgICBjb25zdCB0aW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHNldE1pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlKFwiaWRsZVwiKSwgMCk7XG4gICAgICByZXR1cm4gKCkgPT4gd2luZG93LmNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH0sIFttaXNzaW5nVGhyZWFkUmVjb3ZlcnlTdGF0ZSwgcm91dGVUaHJlYWRFeGlzdHNdKTtcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGlmICghdGhyZWFkc0h5ZHJhdGVkIHx8ICFzcGxpdFZpZXdzSHlkcmF0ZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoIXJvdXRlVGhyZWFkRXhpc3RzKSB7XG4gICAgICBpZiAoXG4gICAgICAgIHNob3VsZFN0YXJ0TWlzc2luZ1RocmVhZFJvdXRlUmVjb3Zlcnkoe1xuICAgICAgICAgIGhhc0tub3duU2VydmVyVGhyZWFkcyxcbiAgICAgICAgICByZWNvdmVyeVN0YXRlOiBtaXNzaW5nVGhyZWFkUmVjb3ZlcnlTdGF0ZSxcbiAgICAgICAgICByb3V0ZVRocmVhZEV4aXN0cyxcbiAgICAgICAgfSkgJiZcbiAgICAgICAgIXJlY292ZXJ5U3RhcnRlZFJlZi5jdXJyZW50XG4gICAgICApIHtcbiAgICAgICAgcmVjb3ZlcnlTdGFydGVkUmVmLmN1cnJlbnQgPSB0cnVlO1xuICAgICAgICBjb25zdCByZWNvdmVyeVJ1biA9IChtaXNzaW5nVGhyZWFkUmVjb3ZlcnlSdW5SZWYuY3VycmVudCArPSAxKTtcbiAgICAgICAgLy8gRGVmZXIgdGhlIFwicGVuZGluZ1wiIG1hcmsgKGFzeW5jIHNldFN0YXRlKTsgdGhlIHJlZiBndWFyZCBhYm92ZSBwcmV2ZW50cyBhXG4gICAgICAgIC8vIHNlY29uZCBzdGFydCBiZWZvcmUgaXQgbGFuZHMsIGFuZCB0aGUgcnVuIGNoZWNrIHNraXBzIGl0IGlmIHRoZSBlcGlzb2RlXG4gICAgICAgIC8vIHdhcyBpbnZhbGlkYXRlZCBpbiB0aGUgbWVhbnRpbWUuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICBpZiAobWlzc2luZ1RocmVhZFJlY292ZXJ5UnVuUmVmLmN1cnJlbnQgPT09IHJlY292ZXJ5UnVuKSB7XG4gICAgICAgICAgICBzZXRNaXNzaW5nVGhyZWFkUmVjb3ZlcnlTdGF0ZShcInBlbmRpbmdcIik7XG4gICAgICAgICAgfVxuICAgICAgICB9LCAwKTtcbiAgICAgICAgdm9pZCBQcm9taXNlLmFsbChbXG4gICAgICAgICAgcmVmcmVzaEVtcHR5Um91dGVSZXN0b3JlU25hcHNob3QocmVhZE5hdGl2ZUFwaSgpKS5jYXRjaCgoKSA9PiBmYWxzZSksXG4gICAgICAgICAgd2FpdEZvckVtcHR5Um91dGVSZXN0b3JlRmFsbGJhY2tEZWxheSgpLFxuICAgICAgICBdKS5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICB3aW5kb3cuY2xlYXJUaW1lb3V0KHBlbmRpbmdUaW1lcik7XG4gICAgICAgICAgaWYgKG1vdW50ZWRSZWYuY3VycmVudCAmJiBtaXNzaW5nVGhyZWFkUmVjb3ZlcnlSdW5SZWYuY3VycmVudCA9PT0gcmVjb3ZlcnlSdW4pIHtcbiAgICAgICAgICAgIHNldE1pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlKFwiZG9uZVwiKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgc2hvdWxkSG9sZE1pc3NpbmdUaHJlYWRSb3V0ZUZhbGxiYWNrKHtcbiAgICAgICAgICBoYXNLbm93blNlcnZlclRocmVhZHMsXG4gICAgICAgICAgcmVjb3ZlcnlTdGF0ZTogbWlzc2luZ1RocmVhZFJlY292ZXJ5U3RhdGUsXG4gICAgICAgICAgcm91dGVUaHJlYWRFeGlzdHMsXG4gICAgICAgIH0pXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChpc1NwbGl0Um91dGUoc2VhcmNoKSkge1xuICAgICAgaWYgKCFzcGxpdFZpZXcpIHtcbiAgICAgICAgdm9pZCBuYXZpZ2F0ZSh7XG4gICAgICAgICAgdG86IFwiLyR0aHJlYWRJZFwiLFxuICAgICAgICAgIHBhcmFtczogeyB0aHJlYWRJZCB9LFxuICAgICAgICAgIHJlcGxhY2U6IHRydWUsXG4gICAgICAgICAgc2VhcmNoOiAocHJldmlvdXMpID0+ICh7XG4gICAgICAgICAgICAuLi5zdHJpcERpZmZTZWFyY2hQYXJhbXMocHJldmlvdXMpLFxuICAgICAgICAgICAgc3BsaXRWaWV3SWQ6IHVuZGVmaW5lZCxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCFyb3V0ZVRocmVhZEV4aXN0cykge1xuICAgICAgdm9pZCBuYXZpZ2F0ZSh7IHRvOiBcIi9cIiwgcmVwbGFjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0sIFtcbiAgICBoYXNLbm93blNlcnZlclRocmVhZHMsXG4gICAgbWlzc2luZ1RocmVhZFJlY292ZXJ5U3RhdGUsXG4gICAgbmF2aWdhdGUsXG4gICAgcm91dGVUaHJlYWRFeGlzdHMsXG4gICAgc2VhcmNoLFxuICAgIHNwbGl0VmlldyxcbiAgICBzcGxpdFZpZXdzSHlkcmF0ZWQsXG4gICAgdGhyZWFkSWQsXG4gICAgdGhyZWFkc0h5ZHJhdGVkLFxuICBdKTtcblxuICBpZiAoXG4gICAgIXRocmVhZHNIeWRyYXRlZCB8fFxuICAgICFzcGxpdFZpZXdzSHlkcmF0ZWQgfHxcbiAgICBzaG91bGRIb2xkTWlzc2luZ1RocmVhZFJvdXRlRmFsbGJhY2soe1xuICAgICAgaGFzS25vd25TZXJ2ZXJUaHJlYWRzLFxuICAgICAgcmVjb3ZlcnlTdGF0ZTogbWlzc2luZ1RocmVhZFJlY292ZXJ5U3RhdGUsXG4gICAgICByb3V0ZVRocmVhZEV4aXN0cyxcbiAgICB9KVxuICApIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGlmIChzcGxpdFZpZXcgJiYgc2VhcmNoLnNwbGl0Vmlld0lkKSB7XG4gICAgcmV0dXJuIDxTcGxpdENoYXRTdXJmYWNlIHNwbGl0Vmlld0lkPXtzZWFyY2guc3BsaXRWaWV3SWR9IHJvdXRlVGhyZWFkSWQ9e3RocmVhZElkfSAvPjtcbiAgfVxuXG4gIGlmICghcm91dGVUaHJlYWRFeGlzdHMpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHJldHVybiA8U2luZ2xlQ2hhdFN1cmZhY2UgdGhyZWFkSWQ9e3RocmVhZElkfSBzZWFyY2g9e3NlYXJjaH0gcHJvamVjdElkPXthY3RpdmVQcm9qZWN0SWR9IC8+O1xufVxuXG5leHBvcnQgY29uc3QgUm91dGUgPSBjcmVhdGVGaWxlUm91dGUoXCIvX2NoYXQvJHRocmVhZElkXCIpKHtcbiAgdmFsaWRhdGVTZWFyY2g6IChzZWFyY2gpID0+IHBhcnNlRGlmZlJvdXRlU2VhcmNoKHNlYXJjaCksXG4gIGNvbXBvbmVudDogQ2hhdFRocmVhZFJvdXRlVmlldyxcbn0pO1xuIl0sImZpbGUiOiIvVXNlcnMvdXNlci8uc3luYXJhL3dvcmt0cmVlcy9kZXZpbi10b29sLWlkbGUtYnVkZ2V0LWNsZWFuL2FwcHMvd2ViL3NyYy9yb3V0ZXMvX2NoYXQuJHRocmVhZElkLnRzeCJ9