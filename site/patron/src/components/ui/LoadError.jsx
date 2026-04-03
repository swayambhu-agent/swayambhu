export function LoadError({ error, onRetry }) {
  const msg = error === 'TIMEOUT' ? 'Request timed out' : 'Failed to load data';
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-red-400">{msg}</span>
      {onRetry && (
        <button onClick={onRetry} className="text-accent hover:text-amber-300 underline text-xs">
          Retry
        </button>
      )}
    </div>
  );
}
