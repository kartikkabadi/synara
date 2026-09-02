import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/src/routes/_chat.$threadId.tsx?tsr-split=component");const _c = __vite__cjsImport0_react_compilerRuntime["c"];const useEffect = __vite__cjsImport3_react["useEffect"]; const useRef = __vite__cjsImport3_react["useRef"]; const useState = __vite__cjsImport3_react["useState"];const _jsxDEV = __vite__cjsImport16_react_jsxDevRuntime["jsxDEV"];import __vite__cjsImport0_react_compilerRuntime from "/node_modules/.vite/deps/react_compiler-runtime.js?v=1556ae44";
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
var _jsxFileName = "/Users/user/.synara/worktrees/devin-tool-idle-budget-clean/apps/web/src/routes/_chat.$threadId.tsx?tsr-split=component";
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
import * as __vite_react_currentExports from "/src/routes/_chat.$threadId.tsx?tsr-split=component";
if (import.meta.hot && !inWebWorker) {
  if (!window.$RefreshReg$) {
    throw new Error(
      "@vitejs/plugin-react can't detect preamble. Something is wrong."
    );
  }

  const currentExports = __vite_react_currentExports;
  queueMicrotask(() => {
    RefreshRuntime.registerExportsForReactRefresh("/Users/user/.synara/worktrees/devin-tool-idle-budget-clean/apps/web/src/routes/_chat.$threadId.tsx?tsr-split=component", currentExports);
    import.meta.hot.accept((nextExports) => {
      if (!nextExports) return;
      const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate("/Users/user/.synara/worktrees/devin-tool-idle-budget-clean/apps/web/src/routes/_chat.$threadId.tsx?tsr-split=component", currentExports, nextExports);
      if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
    });
  });
}
function $RefreshReg$(type, id) { return RefreshRuntime.register(type, "/Users/user/.synara/worktrees/devin-tool-idle-budget-clean/apps/web/src/routes/_chat.$threadId.tsx?tsr-split=component" + ' ' + id); }
function $RefreshSig$() { return RefreshRuntime.createSignatureFunctionForTransform(); }

//# sourceMappingURL=data:application/json;base64,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QUNBVDtHQUNBUDtHQUNBZTtHQUNBTDtHQUNBZjtHQUNBYztFQUFlO0VBQ2hCO0VBQUE7RUFBQTtFQUFBO0VBQUE7RUFBQTtFQUFBO0VBQUE7RUFBQTtFQUFBO0VBQUE7Q0FBQTtFQUFBO0VBQUE7Q0FBQTtDQTNFRHBDLFVBQVUsS0FpRVAsR0FVRjtDQUVELElBQ0UsQ0FBQ29DLG1CQUFELENBQ0NDLHNCQUNEbEMscUNBQXFDO0VBQUE7RUFBQSxlQUVwQmdDO0VBQTBCO0NBRTNDLENBQUMsR0FBQztFQUFBLE9BRUs7Q0FBSTtDQUdiLElBQUlPLGFBQWFmLE9BQU0sYUFBWTtFQUFBO0VBQUE7R0FDMUIsOEJBQUMsa0JBQUQ7SUFBK0JBLG9CQUFNO0lBQTZCTDtHQUFROzs7OztHQUFJO0dBQUE7R0FBQTtFQUFBO0dBQUE7RUFBQTtFQUFBLE9BQTlFO0NBQThFO0NBR3ZGLElBQUksQ0FBQ1ksbUJBQWlCO0VBQUEsT0FDYjtDQUFJO0NBQ2I7Q0FBQTtFQUVPLDhCQUFDLG1CQUFEO0dBQTZCWjtHQUFrQks7R0FBbUJtQjtFQUFlOzs7OztFQUFJO0VBQUE7RUFBQTtFQUFBO0NBQUE7RUFBQTtDQUFBO0NBQUEsT0FBckY7QUFBcUY7Ozs7Ozs7Ozs7Ozs7Ozs7QUE5SjlGO0NBQUEsT0FrSGlDO0VBQUEsR0FDbEJ0QyxzQkFBc0JvQyxRQUFRO0VBQUMsYUFDckJHO0NBQ2Y7QUFBQztBQXJIWDtDQUFBLE9Bc0Z3RTtBQUFLO0FBdEY3RTtDQUFBLE9BbUIwRDVCLFFBQUs7QUFBWTtBQW5CM0U7Q0FBQSxPQUl3QnJCLFNBQVEsV0FBWXNCLE9BQU0sUUFBUztBQUFBO0FBSjNEO0NBQUEsUUFFcURELFFBQUssV0FBa0IsVUFBdkJBLEtBQWdDO0FBQUM7QUFGdEY7Q0FBQSxPQUM4Q0EsTUFBSztBQUFnQjtBQThKbEUsU0FBQUUsYUFBQTtBQUFBLFNBQUEyQix1QkFBQUMiLCJuYW1lcyI6WyJUaHJlYWRJZCIsInVzZU5hdmlnYXRlIiwidXNlRWZmZWN0IiwidXNlUmVmIiwidXNlU3RhdGUiLCJzaG91bGRIb2xkTWlzc2luZ1RocmVhZFJvdXRlRmFsbGJhY2siLCJzaG91bGRTdGFydE1pc3NpbmdUaHJlYWRSb3V0ZVJlY292ZXJ5IiwicmVmcmVzaEVtcHR5Um91dGVSZXN0b3JlU25hcHNob3QiLCJ3YWl0Rm9yRW1wdHlSb3V0ZVJlc3RvcmVGYWxsYmFja0RlbGF5IiwidXNlQ29tcG9zZXJEcmFmdFN0b3JlIiwic3RyaXBEaWZmU2VhcmNoUGFyYW1zIiwicmVhZE5hdGl2ZUFwaSIsImlzU3BsaXRSb3V0ZSIsInNlbGVjdFNwbGl0VmlldyIsInVzZVNwbGl0Vmlld1N0b3JlIiwidXNlU3RvcmUiLCJjcmVhdGVUaHJlYWRFeGlzdHNTZWxlY3RvciIsImNyZWF0ZVRocmVhZFByb2plY3RJZFNlbGVjdG9yIiwiU2luZ2xlQ2hhdFN1cmZhY2UiLCJTcGxpdENoYXRTdXJmYWNlIiwicmVzb2x2ZVNpbmdsZVByb2plY3RJZCIsInN0b3JlIiwicGFyYW1zIiwiUm91dGUiLCJ0aHJlYWRJZCIsInRocmVhZFByb2plY3RJZFNlbGVjdG9yIiwidGhyZWFkRXhpc3RzU2VsZWN0b3IiLCJkcmFmdFRocmVhZFN0YXRlIiwidGhyZWFkRXhpc3RzIiwic2VhcmNoIiwibW91bnRlZFJlZiIsIm1pc3NpbmdUaHJlYWRSZWNvdmVyeVJ1blJlZiIsInJlY292ZXJ5U3RhcnRlZFJlZiIsIndpbmRvdyIsInNldE1pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlIiwidGltZXIiLCJyb3V0ZVRocmVhZEV4aXN0cyIsIm1pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlIiwidGhyZWFkc0h5ZHJhdGVkIiwic3BsaXRWaWV3c0h5ZHJhdGVkIiwiY3VycmVudCIsInJlY292ZXJ5UnVuIiwiUHJvbWlzZSIsInBlbmRpbmdUaW1lciIsInNwbGl0VmlldyIsIm5hdmlnYXRlIiwicHJldmlvdXMiLCJoYXNLbm93blNlcnZlclRocmVhZHMiLCJhY3RpdmVQcm9qZWN0SWQiLCJ1bmRlZmluZWQiLCJDaGF0VGhyZWFkUm91dGVWaWV3IiwiY29tcG9uZW50Il0sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbIl9jaGF0LiR0aHJlYWRJZC50c3g/dHNyLXNwbGl0PWNvbXBvbmVudCJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBGSUxFOiBfY2hhdC4kdGhyZWFkSWQudHN4XG4vLyBQdXJwb3NlOiBSZXNvbHZlIHRoZSBhY3RpdmUgdGhyZWFkIHJvdXRlIGludG8gZWl0aGVyIGEgc2luZ2xlIGNoYXQgc3VyZmFjZSBvciBhIHBlcnNpc3RlZCBzcGxpdCB2aWV3LlxuLy8gTGF5ZXI6IFJvdXRlIGNvbnRhaW5lclxuXG5pbXBvcnQgeyB0eXBlIFByb2plY3RJZCwgVGhyZWFkSWQgfSBmcm9tIFwiQHN5bmFyYS9jb250cmFjdHNcIjtcbmltcG9ydCB7IGNyZWF0ZUZpbGVSb3V0ZSwgdXNlTmF2aWdhdGUgfSBmcm9tIFwiQHRhbnN0YWNrL3JlYWN0LXJvdXRlclwiO1xuaW1wb3J0IHsgdXNlRWZmZWN0LCB1c2VNZW1vLCB1c2VSZWYsIHVzZVN0YXRlIH0gZnJvbSBcInJlYWN0XCI7XG5cbmltcG9ydCB7XG4gIHR5cGUgRW1wdHlSb3V0ZVJlc3RvcmVSZWNvdmVyeVN0YXRlLFxuICBzaG91bGRIb2xkTWlzc2luZ1RocmVhZFJvdXRlRmFsbGJhY2ssXG4gIHNob3VsZFN0YXJ0TWlzc2luZ1RocmVhZFJvdXRlUmVjb3ZlcnksXG59IGZyb20gXCIuLi9jaGF0Um91dGVSZXN0b3JlXCI7XG5pbXBvcnQge1xuICByZWZyZXNoRW1wdHlSb3V0ZVJlc3RvcmVTbmFwc2hvdCxcbiAgd2FpdEZvckVtcHR5Um91dGVSZXN0b3JlRmFsbGJhY2tEZWxheSxcbn0gZnJvbSBcIi4uL2NoYXRSb3V0ZVJlY292ZXJ5XCI7XG5pbXBvcnQgeyB1c2VDb21wb3NlckRyYWZ0U3RvcmUgfSBmcm9tIFwiLi4vY29tcG9zZXJEcmFmdFN0b3JlXCI7XG5pbXBvcnQgeyBwYXJzZURpZmZSb3V0ZVNlYXJjaCwgc3RyaXBEaWZmU2VhcmNoUGFyYW1zIH0gZnJvbSBcIi4uL2RpZmZSb3V0ZVNlYXJjaFwiO1xuaW1wb3J0IHsgcmVhZE5hdGl2ZUFwaSB9IGZyb20gXCIuLi9uYXRpdmVBcGlcIjtcbmltcG9ydCB7IGlzU3BsaXRSb3V0ZSB9IGZyb20gXCIuLi9zcGxpdFZpZXdSb3V0ZVwiO1xuaW1wb3J0IHsgc2VsZWN0U3BsaXRWaWV3LCB1c2VTcGxpdFZpZXdTdG9yZSB9IGZyb20gXCIuLi9zcGxpdFZpZXdTdG9yZVwiO1xuaW1wb3J0IHsgdXNlU3RvcmUgfSBmcm9tIFwiLi4vc3RvcmVcIjtcbmltcG9ydCB7IGNyZWF0ZVRocmVhZEV4aXN0c1NlbGVjdG9yLCBjcmVhdGVUaHJlYWRQcm9qZWN0SWRTZWxlY3RvciB9IGZyb20gXCIuLi9zdG9yZVNlbGVjdG9yc1wiO1xuaW1wb3J0IHsgU2luZ2xlQ2hhdFN1cmZhY2UgfSBmcm9tIFwiLi4vY29tcG9uZW50cy9jaGF0L1NpbmdsZUNoYXRTdXJmYWNlXCI7XG5pbXBvcnQgeyBTcGxpdENoYXRTdXJmYWNlIH0gZnJvbSBcIi4uL2NvbXBvbmVudHMvY2hhdC9TcGxpdENoYXRTdXJmYWNlXCI7XG5pbXBvcnQgeyByZXNvbHZlU2luZ2xlUHJvamVjdElkIH0gZnJvbSBcIi4vLWNoYXRUaHJlYWRSb3V0ZS5sb2dpY1wiO1xuXG5mdW5jdGlvbiBDaGF0VGhyZWFkUm91dGVWaWV3KCkge1xuICBjb25zdCB0aHJlYWRzSHlkcmF0ZWQgPSB1c2VTdG9yZSgoc3RvcmUpID0+IHN0b3JlLnRocmVhZHNIeWRyYXRlZCk7XG4gIGNvbnN0IGhhc0tub3duU2VydmVyVGhyZWFkcyA9IHVzZVN0b3JlKChzdG9yZSkgPT4gKHN0b3JlLnRocmVhZElkcz8ubGVuZ3RoID8/IDApID4gMCk7XG4gIGNvbnN0IHRocmVhZElkID0gUm91dGUudXNlUGFyYW1zKHtcbiAgICBzZWxlY3Q6IChwYXJhbXMpID0+IFRocmVhZElkLm1ha2VVbnNhZmUocGFyYW1zLnRocmVhZElkKSxcbiAgfSk7XG4gIGNvbnN0IHNlYXJjaCA9IFJvdXRlLnVzZVNlYXJjaCgpO1xuICBjb25zdCB0aHJlYWRQcm9qZWN0SWRTZWxlY3RvciA9IGNyZWF0ZVRocmVhZFByb2plY3RJZFNlbGVjdG9yKHRocmVhZElkKTtcbiAgY29uc3QgdGhyZWFkRXhpc3RzU2VsZWN0b3IgPSBjcmVhdGVUaHJlYWRFeGlzdHNTZWxlY3Rvcih0aHJlYWRJZCk7XG4gIGNvbnN0IHRocmVhZFByb2plY3RJZDogUHJvamVjdElkIHwgbnVsbCA9IHVzZVN0b3JlKHRocmVhZFByb2plY3RJZFNlbGVjdG9yKTtcbiAgY29uc3QgdGhyZWFkRXhpc3RzID0gdXNlU3RvcmUodGhyZWFkRXhpc3RzU2VsZWN0b3IpO1xuICBjb25zdCBkcmFmdFRocmVhZFN0YXRlID0gdXNlQ29tcG9zZXJEcmFmdFN0b3JlKFxuICAgIChzdG9yZSkgPT4gc3RvcmUuZHJhZnRUaHJlYWRzQnlUaHJlYWRJZFt0aHJlYWRJZF0gPz8gbnVsbCxcbiAgKTtcbiAgY29uc3QgZHJhZnRUaHJlYWRFeGlzdHMgPSBkcmFmdFRocmVhZFN0YXRlICE9PSBudWxsO1xuICBjb25zdCByb3V0ZVRocmVhZEV4aXN0cyA9IHRocmVhZEV4aXN0cyB8fCBkcmFmdFRocmVhZEV4aXN0cztcbiAgY29uc3Qgc3BsaXRWaWV3ID0gdXNlU3BsaXRWaWV3U3RvcmUoXG4gICAgdXNlTWVtbygoKSA9PiBzZWxlY3RTcGxpdFZpZXcoc2VhcmNoLnNwbGl0Vmlld0lkID8/IG51bGwpLCBbc2VhcmNoLnNwbGl0Vmlld0lkXSksXG4gICk7XG4gIGNvbnN0IHNwbGl0Vmlld3NIeWRyYXRlZCA9IHVzZVNwbGl0Vmlld1N0b3JlKChzdG9yZSkgPT4gc3RvcmUuaGFzSHlkcmF0ZWQpO1xuICBjb25zdCBhY3RpdmVQcm9qZWN0SWQgPSByZXNvbHZlU2luZ2xlUHJvamVjdElkKHtcbiAgICB0aHJlYWRQcm9qZWN0SWQsXG4gICAgZHJhZnRQcm9qZWN0SWQ6IGRyYWZ0VGhyZWFkU3RhdGU/LnByb2plY3RJZCA/PyBudWxsLFxuICB9KTtcbiAgY29uc3QgbmF2aWdhdGUgPSB1c2VOYXZpZ2F0ZSgpO1xuICBjb25zdCBbbWlzc2luZ1RocmVhZFJlY292ZXJ5U3RhdGUsIHNldE1pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlXSA9XG4gICAgdXNlU3RhdGU8RW1wdHlSb3V0ZVJlc3RvcmVSZWNvdmVyeVN0YXRlPihcImlkbGVcIik7XG4gIGNvbnN0IG1vdW50ZWRSZWYgPSB1c2VSZWYodHJ1ZSk7XG4gIGNvbnN0IG1pc3NpbmdUaHJlYWRSZWNvdmVyeVJ1blJlZiA9IHVzZVJlZigwKTtcbiAgLy8gU3luY2hyb25vdXMgcmUtZW50cnkgZ3VhcmQ6IHRoZSBcInBlbmRpbmdcIiB0cmFuc2l0aW9uIGJlbG93IGlzIGRlZmVycmVkIChhc3luY1xuICAvLyBzZXRTdGF0ZSksIHNvIHRoaXMgcmVmIGtlZXBzIHRoZSByZWNvdmVyeSBmcm9tIHN0YXJ0aW5nIHR3aWNlIGluIHRoZSBpbnRlcmltLlxuICAvLyBJdCBpcyBjbGVhcmVkIHN5bmNocm9ub3VzbHkgd2hlbmV2ZXIgYW4gZXBpc29kZSBpcyBpbnZhbGlkYXRlZCAobmV3IHRocmVhZFxuICAvLyByb3V0ZSwgb3IgdGhlIHRocmVhZCBhcHBlYXJpbmcpLlxuICBjb25zdCByZWNvdmVyeVN0YXJ0ZWRSZWYgPSB1c2VSZWYoZmFsc2UpO1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgcmV0dXJuICgpID0+IHtcbiAgICAgIG1vdW50ZWRSZWYuY3VycmVudCA9IGZhbHNlO1xuICAgIH07XG4gIH0sIFtdKTtcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIC8vIEludmFsaWRhdGUgYW55IGluLWZsaWdodCByZWNvdmVyeSBhbmQgc3RhcnQgYSBmcmVzaCBlcGlzb2RlIGZvciB0aGUgbmV3XG4gICAgLy8gdGhyZWFkIHJvdXRlLiBUaGUgcnVuIGJ1bXAgKyBndWFyZCByZXNldCBhcmUgc3luY2hyb25vdXMgKHNvIGEgc3RhbGUgYXN5bmNcbiAgICAvLyBjb21wbGV0aW9uIGNhbm5vdCBzdGFtcCBcImRvbmVcIik7IHRoZSBzdGF0ZSByZXNldCBpcyBkZWZlcnJlZCBhc3luYyBzZXRTdGF0ZS5cbiAgICBtaXNzaW5nVGhyZWFkUmVjb3ZlcnlSdW5SZWYuY3VycmVudCArPSAxO1xuICAgIHJlY292ZXJ5U3RhcnRlZFJlZi5jdXJyZW50ID0gZmFsc2U7XG4gICAgY29uc3QgdGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiBzZXRNaXNzaW5nVGhyZWFkUmVjb3ZlcnlTdGF0ZShcImlkbGVcIiksIDApO1xuICAgIHJldHVybiAoKSA9PiB3aW5kb3cuY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgfSwgW3RocmVhZElkXSk7XG5cbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBpZiAocm91dGVUaHJlYWRFeGlzdHMgJiYgbWlzc2luZ1RocmVhZFJlY292ZXJ5U3RhdGUgIT09IFwiaWRsZVwiKSB7XG4gICAgICBtaXNzaW5nVGhyZWFkUmVjb3ZlcnlSdW5SZWYuY3VycmVudCArPSAxO1xuICAgICAgcmVjb3ZlcnlTdGFydGVkUmVmLmN1cnJlbnQgPSBmYWxzZTtcbiAgICAgIGNvbnN0IHRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4gc2V0TWlzc2luZ1RocmVhZFJlY292ZXJ5U3RhdGUoXCJpZGxlXCIpLCAwKTtcbiAgICAgIHJldHVybiAoKSA9PiB3aW5kb3cuY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB9XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfSwgW21pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlLCByb3V0ZVRocmVhZEV4aXN0c10pO1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgaWYgKCF0aHJlYWRzSHlkcmF0ZWQgfHwgIXNwbGl0Vmlld3NIeWRyYXRlZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICghcm91dGVUaHJlYWRFeGlzdHMpIHtcbiAgICAgIGlmIChcbiAgICAgICAgc2hvdWxkU3RhcnRNaXNzaW5nVGhyZWFkUm91dGVSZWNvdmVyeSh7XG4gICAgICAgICAgaGFzS25vd25TZXJ2ZXJUaHJlYWRzLFxuICAgICAgICAgIHJlY292ZXJ5U3RhdGU6IG1pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlLFxuICAgICAgICAgIHJvdXRlVGhyZWFkRXhpc3RzLFxuICAgICAgICB9KSAmJlxuICAgICAgICAhcmVjb3ZlcnlTdGFydGVkUmVmLmN1cnJlbnRcbiAgICAgICkge1xuICAgICAgICByZWNvdmVyeVN0YXJ0ZWRSZWYuY3VycmVudCA9IHRydWU7XG4gICAgICAgIGNvbnN0IHJlY292ZXJ5UnVuID0gKG1pc3NpbmdUaHJlYWRSZWNvdmVyeVJ1blJlZi5jdXJyZW50ICs9IDEpO1xuICAgICAgICAvLyBEZWZlciB0aGUgXCJwZW5kaW5nXCIgbWFyayAoYXN5bmMgc2V0U3RhdGUpOyB0aGUgcmVmIGd1YXJkIGFib3ZlIHByZXZlbnRzIGFcbiAgICAgICAgLy8gc2Vjb25kIHN0YXJ0IGJlZm9yZSBpdCBsYW5kcywgYW5kIHRoZSBydW4gY2hlY2sgc2tpcHMgaXQgaWYgdGhlIGVwaXNvZGVcbiAgICAgICAgLy8gd2FzIGludmFsaWRhdGVkIGluIHRoZSBtZWFudGltZS5cbiAgICAgICAgY29uc3QgcGVuZGluZ1RpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgIGlmIChtaXNzaW5nVGhyZWFkUmVjb3ZlcnlSdW5SZWYuY3VycmVudCA9PT0gcmVjb3ZlcnlSdW4pIHtcbiAgICAgICAgICAgIHNldE1pc3NpbmdUaHJlYWRSZWNvdmVyeVN0YXRlKFwicGVuZGluZ1wiKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0sIDApO1xuICAgICAgICB2b2lkIFByb21pc2UuYWxsKFtcbiAgICAgICAgICByZWZyZXNoRW1wdHlSb3V0ZVJlc3RvcmVTbmFwc2hvdChyZWFkTmF0aXZlQXBpKCkpLmNhdGNoKCgpID0+IGZhbHNlKSxcbiAgICAgICAgICB3YWl0Rm9yRW1wdHlSb3V0ZVJlc3RvcmVGYWxsYmFja0RlbGF5KCksXG4gICAgICAgIF0pLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICAgIHdpbmRvdy5jbGVhclRpbWVvdXQocGVuZGluZ1RpbWVyKTtcbiAgICAgICAgICBpZiAobW91bnRlZFJlZi5jdXJyZW50ICYmIG1pc3NpbmdUaHJlYWRSZWNvdmVyeVJ1blJlZi5jdXJyZW50ID09PSByZWNvdmVyeVJ1bikge1xuICAgICAgICAgICAgc2V0TWlzc2luZ1RocmVhZFJlY292ZXJ5U3RhdGUoXCJkb25lXCIpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBzaG91bGRIb2xkTWlzc2luZ1RocmVhZFJvdXRlRmFsbGJhY2soe1xuICAgICAgICAgIGhhc0tub3duU2VydmVyVGhyZWFkcyxcbiAgICAgICAgICByZWNvdmVyeVN0YXRlOiBtaXNzaW5nVGhyZWFkUmVjb3ZlcnlTdGF0ZSxcbiAgICAgICAgICByb3V0ZVRocmVhZEV4aXN0cyxcbiAgICAgICAgfSlcbiAgICAgICkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGlzU3BsaXRSb3V0ZShzZWFyY2gpKSB7XG4gICAgICBpZiAoIXNwbGl0Vmlldykge1xuICAgICAgICB2b2lkIG5hdmlnYXRlKHtcbiAgICAgICAgICB0bzogXCIvJHRocmVhZElkXCIsXG4gICAgICAgICAgcGFyYW1zOiB7IHRocmVhZElkIH0sXG4gICAgICAgICAgcmVwbGFjZTogdHJ1ZSxcbiAgICAgICAgICBzZWFyY2g6IChwcmV2aW91cykgPT4gKHtcbiAgICAgICAgICAgIC4uLnN0cmlwRGlmZlNlYXJjaFBhcmFtcyhwcmV2aW91cyksXG4gICAgICAgICAgICBzcGxpdFZpZXdJZDogdW5kZWZpbmVkLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoIXJvdXRlVGhyZWFkRXhpc3RzKSB7XG4gICAgICB2b2lkIG5hdmlnYXRlKHsgdG86IFwiL1wiLCByZXBsYWNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSwgW1xuICAgIGhhc0tub3duU2VydmVyVGhyZWFkcyxcbiAgICBtaXNzaW5nVGhyZWFkUmVjb3ZlcnlTdGF0ZSxcbiAgICBuYXZpZ2F0ZSxcbiAgICByb3V0ZVRocmVhZEV4aXN0cyxcbiAgICBzZWFyY2gsXG4gICAgc3BsaXRWaWV3LFxuICAgIHNwbGl0Vmlld3NIeWRyYXRlZCxcbiAgICB0aHJlYWRJZCxcbiAgICB0aHJlYWRzSHlkcmF0ZWQsXG4gIF0pO1xuXG4gIGlmIChcbiAgICAhdGhyZWFkc0h5ZHJhdGVkIHx8XG4gICAgIXNwbGl0Vmlld3NIeWRyYXRlZCB8fFxuICAgIHNob3VsZEhvbGRNaXNzaW5nVGhyZWFkUm91dGVGYWxsYmFjayh7XG4gICAgICBoYXNLbm93blNlcnZlclRocmVhZHMsXG4gICAgICByZWNvdmVyeVN0YXRlOiBtaXNzaW5nVGhyZWFkUmVjb3ZlcnlTdGF0ZSxcbiAgICAgIHJvdXRlVGhyZWFkRXhpc3RzLFxuICAgIH0pXG4gICkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgaWYgKHNwbGl0VmlldyAmJiBzZWFyY2guc3BsaXRWaWV3SWQpIHtcbiAgICByZXR1cm4gPFNwbGl0Q2hhdFN1cmZhY2Ugc3BsaXRWaWV3SWQ9e3NlYXJjaC5zcGxpdFZpZXdJZH0gcm91dGVUaHJlYWRJZD17dGhyZWFkSWR9IC8+O1xuICB9XG5cbiAgaWYgKCFyb3V0ZVRocmVhZEV4aXN0cykge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgcmV0dXJuIDxTaW5nbGVDaGF0U3VyZmFjZSB0aHJlYWRJZD17dGhyZWFkSWR9IHNlYXJjaD17c2VhcmNofSBwcm9qZWN0SWQ9e2FjdGl2ZVByb2plY3RJZH0gLz47XG59XG5cbmV4cG9ydCBjb25zdCBSb3V0ZSA9IGNyZWF0ZUZpbGVSb3V0ZShcIi9fY2hhdC8kdGhyZWFkSWRcIikoe1xuICB2YWxpZGF0ZVNlYXJjaDogKHNlYXJjaCkgPT4gcGFyc2VEaWZmUm91dGVTZWFyY2goc2VhcmNoKSxcbiAgY29tcG9uZW50OiBDaGF0VGhyZWFkUm91dGVWaWV3LFxufSk7XG4iXSwiZmlsZSI6Ii9Vc2Vycy91c2VyLy5zeW5hcmEvd29ya3RyZWVzL2RldmluLXRvb2wtaWRsZS1idWRnZXQtY2xlYW4vYXBwcy93ZWIvc3JjL3JvdXRlcy9fY2hhdC4kdGhyZWFkSWQudHN4In0=