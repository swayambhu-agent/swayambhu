import { useState } from 'react';
import { api } from '../lib/api.js';

export default function LoginScreen({ onLogin }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api('/health', key);
      onLogin(key);
    } catch (err) {
      setError(err.message === 'UNAUTHORIZED' ? 'Invalid key' : 'Connection failed');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={handleSubmit} className="bg-bg-panel border border-border rounded-lg p-8 w-full max-w-sm">
        <h1 className="text-accent font-bold text-lg tracking-widest mb-1">SWAYAMBHU</h1>
        <p className="text-gray-500 text-sm mb-6">Patron Dashboard</p>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Patron key"
          className="w-full bg-bg border border-border rounded px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-accent mb-4"
          autoFocus
        />
        {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
        <button
          type="submit"
          disabled={loading || !key}
          className="w-full bg-accent/20 border border-accent text-accent font-semibold py-2.5 rounded text-sm hover:bg-accent/30 transition disabled:opacity-40"
        >
          {loading ? 'Connecting...' : 'Enter'}
        </button>
      </form>
    </div>
  );
}
