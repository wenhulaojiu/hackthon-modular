export type WorkspaceSnapshot = Readonly<{ token: string; version: number }>;

const CHANGED_MESSAGE = '微信账号已切换，请刷新页面后再操作。';
let workspaceToken = '';
let version = 0;
let invalidated = '';
const controllers = new Set<AbortController>();
const listeners = new Set<(message: string) => void>();

export class WorkspaceChangedError extends Error {
  readonly code = 'WORKSPACE_CHANGED';
  constructor(message = CHANGED_MESSAGE) { super(message); this.name = 'WorkspaceChangedError'; }
}

export const getWorkspaceToken = () => workspaceToken;
export const getWorkspaceScope = () => workspaceToken.split('@')[0] || 'legacy';
export const getWorkspaceInvalidation = () => invalidated;
export const validWorkspaceToken = (token: unknown): token is string => typeof token === 'string' && /^(?:legacy|acct-[a-f0-9]{20})@[1-9]\d*$/.test(token);

export function setWorkspaceToken(token: string) {
  if (!validWorkspaceToken(token)) throw new Error('工作空间标识无效，请更新本地版后重试。');
  if (workspaceToken !== token) version += 1;
  workspaceToken = token;
  // 已失效的页面只通过完整刷新恢复，避免旧回调在切换完成后借用新标识。
}

export function assertWorkspaceCurrent(snapshot?: WorkspaceSnapshot) {
  if (invalidated || !workspaceToken || (snapshot && (snapshot.token !== workspaceToken || snapshot.version !== version))) throw new WorkspaceChangedError(invalidated || CHANGED_MESSAGE);
}

export function captureWorkspace(): WorkspaceSnapshot {
  assertWorkspaceCurrent();
  return { token: workspaceToken, version };
}

export function workspaceHeaders(headers?: HeadersInit, snapshot = captureWorkspace()): Headers {
  assertWorkspaceCurrent(snapshot);
  const next = new Headers(headers);
  next.set('X-Kexu-Workspace', snapshot.token);
  return next;
}

export function registerWorkspaceController(controller: AbortController) {
  if (invalidated) controller.abort();
  else controllers.add(controller);
  return () => { controllers.delete(controller); };
}

export function subscribeWorkspaceInvalidation(listener: (message: string) => void) {
  listeners.add(listener);
  if (invalidated) listener(invalidated);
  return () => { listeners.delete(listener); };
}

export function markWorkspaceChanged(message = CHANGED_MESSAGE) {
  if (invalidated) return;
  invalidated = message;
  version += 1;
  controllers.forEach(controller => controller.abort());
  controllers.clear();
  listeners.forEach(listener => listener(message));
}

export function beginWorkspaceSwitch() {
  markWorkspaceChanged('微信数据账号切换已开始，当前页面已暂停操作。切换完成后将重新加载；未自动刷新时请手动刷新工作空间。');
}

export async function workspaceFetch(input: RequestInfo | URL, init: RequestInit = {}, snapshot = captureWorkspace()): Promise<Response> {
  // 请求开始与结束都核对版本，旧异步操作不能借用新账号标识提交数据。
  const headers = workspaceHeaders(init.headers, snapshot);
  const controller = new AbortController();
  const unregister = registerWorkspaceController(controller);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetch(input, { ...init, headers, signal });
    if (response.headers.get('content-type')?.includes('json')) {
      const payload = await response.clone().json().catch(() => null) as { code?: string; error?: string; workspaceToken?: unknown; active?: { workspaceToken?: unknown } } | null;
      if (response.status === 409 && payload?.code === 'WORKSPACE_CHANGED') {
        markWorkspaceChanged(payload.error || CHANGED_MESSAGE);
        throw new WorkspaceChangedError(payload.error || CHANGED_MESSAGE);
      }
      const responseToken = payload?.workspaceToken ?? payload?.active?.workspaceToken;
      if (responseToken !== undefined && responseToken !== snapshot.token) {
        markWorkspaceChanged();
        throw new WorkspaceChangedError();
      }
    }
    assertWorkspaceCurrent(snapshot);
    return response;
  } finally { unregister(); }
}
