import { api } from '../../lib/api.js';

const base = '/api/reflection-chats';
export function createChatApi(request = api) {
  const path = id => `${base}/${encodeURIComponent(id)}`;
  return {
    create: signal => request(base, { method: 'POST', body: {}, signal }),
    list: (cursor, signal) => request(`${base}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
    read: (id, before, signal) => request(`${path(id)}${before ? `?before_revision=${before}` : ''}`, { signal }),
    remove: (id, signal) => request(path(id), { method: 'DELETE', body: {}, signal }),
    send: (id, body, signal) => request(`${path(id)}/turns`, { method: 'POST', body, signal }),
    support: (country, locale, signal) => request(`${base}/support?country=${encodeURIComponent(country)}&locale=${locale}`, { signal }),
  };
}
export const chatApi = createChatApi();
