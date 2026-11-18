import { useEffect, useRef, useState } from 'react';
import { getToken } from '../api.js';

/**
 * Subscribes to the server's SSE stream. EventSource reconnects on its own;
 * we expose the connection state for the "live" indicator.
 */
export function useEvents(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) return undefined;
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.addEventListener('connected', () => setConnected(true));
    es.onerror = () => setConnected(false);
    for (const type of ['reminder', 'started', 'blocks-changed']) {
      es.addEventListener(type, (e) => ref.current[type]?.(JSON.parse(e.data)));
    }
    return () => es.close();
  }, []);

  return connected;
}

export function notifyBrowser(title, body) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: '/favicon.ico', tag: title });
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}
