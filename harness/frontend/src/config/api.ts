// API configuration - uses relative paths with Vite proxy in development
export const API_CONFIG = {
  ENDPOINTS: {
    CHAT: "/api/chat",
    ABORT: "/api/abort",
    SESSIONS: "/api/sessions",
    PROJECTS: "/api/projects",
  },
} as const;

export const getApiUrl = (endpoint: string) => {
  return endpoint;
};

export const getAbortUrl = (requestId: string) => {
  return `${API_CONFIG.ENDPOINTS.ABORT}/${requestId}`;
};

export const getChatUrl = () => {
  return API_CONFIG.ENDPOINTS.CHAT;
};

export const getSessionCreateUrl = () => {
  return API_CONFIG.ENDPOINTS.SESSIONS;
};

export const getSessionUrl = (sessionId: string) => {
  return `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}`;
};

export const getSessionMessageUrl = (sessionId: string) => {
  return `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/message`;
};

export const getSessionActivityUrl = (sessionId: string) => {
  return `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/activity`;
};

export const getSessionMessagesUrl = (
  sessionId: string,
  options?: { limit?: number; before?: number },
) => {
  const base = `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/messages`;
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.before !== undefined) params.set("before", String(options.before));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
};

export const getSessionAbortUrl = (sessionId: string) => {
  return `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/abort`;
};

export const getSessionTaskStopUrl = (sessionId: string, taskId: string) => {
  return `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/stop`;
};

export const getSessionStreamUrl = (sessionId: string) => {
  return `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/stream`;
};

export const getSessionIndexStreamUrl = () => {
  return `${API_CONFIG.ENDPOINTS.SESSIONS}/index/stream`;
};

export const getSessionRenameUrl = (sessionId: string) => {
  return `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/rename`;
};

export const getSessionReadUrl = (sessionId: string) => {
  return `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/read`;
};

export const getSessionArchiveUrl = (sessionId: string) => {
  return `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/archive`;
};

export const getProjectsUrl = () => {
  return API_CONFIG.ENDPOINTS.PROJECTS;
};

export const getHistoriesUrl = (projectPath: string) => {
  const encodedPath = encodeURIComponent(projectPath);
  return `${API_CONFIG.ENDPOINTS.SESSIONS}?project=${encodedPath}`;
};

export const getConversationUrl = (
  _projectPath: string,
  sessionId: string,
  options?: { limit?: number; before?: number },
) => {
  return getSessionMessagesUrl(sessionId, options);
};

export const getCreateProjectUrl = () => "/api/projects/create";

export const getProvidersStatusUrl = () => "/api/providers/status";

export const getProvidersCatalogUrl = () => "/api/providers/catalog";

export const getProviderSettingsUrl = () => "/api/providers/settings";

export const getProviderSettingsTelegramTestUrl = () =>
  "/api/providers/settings/telegram/test";

export const getUserPreferencesUrl = () => "/api/preferences";

export const getPiProviderProfilesUrl = () => "/api/providers/pi-profiles";

export const getPiProviderProfileUrl = (id: string) =>
  `/api/providers/pi-profiles/${encodeURIComponent(id)}`;

export const getOpenRouterClaudeProfilesUrl = () =>
  "/api/providers/openrouter-claude-profiles";

export const getOpenRouterClaudeProfileUrl = (id: string) =>
  `/api/providers/openrouter-claude-profiles/${encodeURIComponent(id)}`;

export const getRemoteControlStatusUrl = () => "/api/remote-control/status";

export const getToolsStatusUrl = () => "/api/tools/status";
export const getToolsConfigUrl = () => "/api/tools/config";
export const getToolsUpdateUrl = () => "/api/tools/update";

export const getRenameSessionUrl = (_projectPath: string, sessionId: string) =>
  getSessionRenameUrl(sessionId);

export const getSessionQueueUrl = (sessionId: string) =>
  `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/queue`;

export const getSessionQueueItemUrl = (sessionId: string, queuedId: string) =>
  `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}`;

export const getSessionQueueSendNowUrl = (
  sessionId: string,
  queuedId: string,
) =>
  `${API_CONFIG.ENDPOINTS.SESSIONS}/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/send-now`;

export const getLoopsUrl = (sessionId?: string) => {
  const base = "/api/loops";
  return sessionId ? `${base}?sessionId=${encodeURIComponent(sessionId)}` : base;
};

export const getLoopUrl = (loopId: string) =>
  `/api/loops/${encodeURIComponent(loopId)}`;

export const getLoopPlayUrl = (loopId: string) =>
  `/api/loops/${encodeURIComponent(loopId)}/play`;

export const getLoopPauseUrl = (loopId: string) =>
  `/api/loops/${encodeURIComponent(loopId)}/pause`;
