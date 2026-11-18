// Pushes real-time events to connected browsers over Server-Sent Events,
// and optionally sends email reminders when SMTP is configured.

const clients = new Map(); // userId -> Set<res>

export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  return () => {
    clients.get(userId)?.delete(res);
    if (clients.get(userId)?.size === 0) clients.delete(userId);
  };
}

export function connectedCount(userId) {
  return clients.get(userId)?.size ?? 0;
}

export function sendEvent(userId, type, data) {
  const set = clients.get(userId);
  if (!set) return 0;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
  return set.size;
}

// Keep proxies from closing idle SSE connections.
setInterval(() => {
  for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
}, 25_000).unref();

// ---------- Email (optional) ----------
let transporterPromise = null;

export function emailEnabled() {
  return Boolean(process.env.SMTP_HOST);
}

async function getTransporter() {
  transporterPromise ??= import('nodemailer').then(({ default: nodemailer }) =>
    nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    }),
  );
  return transporterPromise;
}

export async function sendEmail({ to, subject, text }) {
  if (!emailEnabled()) return false;
  const transporter = await getTransporter();
  await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
  return true;
}
