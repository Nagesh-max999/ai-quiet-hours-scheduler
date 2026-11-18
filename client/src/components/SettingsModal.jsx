import { useState } from 'react';
import { api, timeZone } from '../api.js';
import { useAuth } from '../App.jsx';
import { useToast } from './Toasts.jsx';

export default function SettingsModal({ emailAvailable, onClose }) {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const prefs = user.preferences ?? {};
  const [form, setForm] = useState({
    defaultReminderMinutes: prefs.defaultReminderMinutes ?? 10,
    emailReminders: Boolean(prefs.emailReminders),
  });
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  async function save() {
    try {
      const { user: updated } = await api.updatePreferences({ ...form, defaultReminderMinutes: Number(form.defaultReminderMinutes), timeZone });
      setUser(updated);
      toast('Settings saved', { type: 'success' });
      onClose();
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }

  async function enableNotifications() {
    setPermission(await Notification.requestPermission());
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <label>
          Default reminder (minutes before a block)
          <input
            type="number"
            min={0}
            max={120}
            value={form.defaultReminderMinutes}
            onChange={(e) => setForm((f) => ({ ...f, defaultReminderMinutes: e.target.value }))}
          />
        </label>

        <div className="setting-row">
          <div>
            <strong>Desktop notifications</strong>
            <span className="muted small block">Get a system notification when a reminder fires.</span>
          </div>
          {permission === 'granted' ? (
            <span className="tag tag-live">Enabled</span>
          ) : permission === 'unsupported' ? (
            <span className="tag">Unsupported</span>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={enableNotifications} disabled={permission === 'denied'}>
              {permission === 'denied' ? 'Blocked in browser' : 'Enable'}
            </button>
          )}
        </div>

        <label className={`setting-row ${emailAvailable ? '' : 'is-disabled'}`}>
          <div>
            <strong>Email reminders</strong>
            <span className="muted small block">
              {emailAvailable ? `Sent to ${user.email}` : 'Server has no SMTP configured (see README).'}
            </span>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={form.emailReminders}
            disabled={!emailAvailable}
            onChange={(e) => setForm((f) => ({ ...f, emailReminders: e.target.checked }))}
          />
        </label>

        <p className="muted small">Time zone: {timeZone}</p>

        <div className="modal-actions">
          <div className="btn-group push-right">
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
