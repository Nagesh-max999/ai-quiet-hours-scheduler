const TOKEN_KEY = 'qh_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) - session still works in memory */
  }
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const api = {
  health: () => request('GET', '/health'),
  register: (data) => request('POST', '/auth/register', { ...data, timeZone }),
  login: (data) => request('POST', '/auth/login', data),
  me: () => request('GET', '/auth/me'),
  updatePreferences: (prefs) => request('PATCH', '/auth/preferences', prefs),

  listBlocks: (from, to) => request('GET', `/blocks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  createBlock: (block) => request('POST', '/blocks', block),
  createBlocks: (blocks, skipConflicts = false) => request('POST', '/blocks', { blocks, skipConflicts }),
  updateBlock: (id, patch) => request('PUT', `/blocks/${id}`, patch),
  deleteBlock: (id, series = false) => request('DELETE', `/blocks/${id}${series ? '?series=1' : ''}`),

  parse: (text) => request('POST', '/ai/parse', { text, timeZone }),
  insights: () => request('POST', '/ai/insights', { timeZone }),
  chat: (messages) => request('POST', '/ai/chat', { messages, timeZone }),
};

export { timeZone };
