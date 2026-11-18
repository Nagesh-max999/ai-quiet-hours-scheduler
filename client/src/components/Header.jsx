import { useAuth } from '../App.jsx';

export default function Header({ user, live, ai, onSettings }) {
  const { signOut } = useAuth();
  const aiLabel = ai?.provider === 'claude' ? 'Claude AI' : 'Offline AI';

  return (
    <header className="header">
      <div className="container header-inner">
        <div className="brand">
          <span className="brand-mark">🌙</span> Quiet Hours
        </div>
        <div className="header-right">
          {ai && (
            <span className={`pill ${ai.provider === 'claude' ? 'pill-ai' : ''}`} title={ai.model ? `Model: ${ai.model}` : 'Set ANTHROPIC_API_KEY on the server to enable Claude'}>
              ✨ {aiLabel}
            </span>
          )}
          <span className={`pill ${live ? 'pill-live' : ''}`} title={live ? 'Receiving live reminders' : 'Reconnecting…'}>
            <span className="dot" /> {live ? 'Live' : 'Offline'}
          </span>
          <span className="user-name hide-sm">Hi, {user.name.split(' ')[0]}</span>
          <button className="btn btn-ghost" onClick={onSettings}>
            Settings
          </button>
          <button className="btn btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
