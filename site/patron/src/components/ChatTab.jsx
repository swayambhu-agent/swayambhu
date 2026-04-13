import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { marked } from '../lib/format.js';
import { HB_SAFETY, TIMEZONE, LOCALE } from '../lib/config.js';
import { LoadError } from './ui/LoadError.jsx';

export default function ChatTab({ patronKey, chatsRev }) {
  const [chats, setChats] = useState([]);
  const [selectedChat, setSelectedChat] = useState(null);
  const [chatData, setChatData] = useState(null);
  const [participants, setParticipants] = useState({});
  const [loading, setLoading] = useState(false);

  const refreshChats = useCallback(async () => {
    try {
      const d = await api('/chats', patronKey);
      const list = d.chats || [];
      setChats(list);
      if (list.length > 0) setSelectedChat(prev => prev || list[0].key);
    } catch {}
  }, [patronKey]);

  useEffect(() => {
    refreshChats();
    const iv = setInterval(refreshChats, HB_SAFETY);
    return () => clearInterval(iv);
  }, [refreshChats, chatsRev]);

  const loadChat = useCallback(async (platform, channelId) => {
    setLoading(true);
    try {
      const d = await api(`/chat/${platform}/${channelId}`, patronKey);
      setChatData(d.chat || null);
      setParticipants(d.participants || {});
    } catch { setChatData(null); }
    setLoading(false);
  }, [patronKey]);

  useEffect(() => {
    if (selectedChat) {
      const c = chats.find(ch => ch.key === selectedChat);
      if (c) loadChat(c.platform, c.channel_id);
    }
  }, [selectedChat, chats, loadChat]);

  // Auto-refresh selected chat
  useEffect(() => {
    if (!selectedChat) return;
    const c = chats.find(ch => ch.key === selectedChat);
    if (!c) return;
    const iv = setInterval(() => loadChat(c.platform, c.channel_id), HB_SAFETY);
    return () => clearInterval(iv);
  }, [selectedChat, chats, loadChat]);

  // Local formatters — intentionally different from the global formatTime
  const formatTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const roleColors = {
    user: { bg: 'bg-blue-900/30', border: 'border-blue-700', text: 'text-blue-300', label: 'text-blue-400' },
    assistant: { bg: 'bg-green-900/30', border: 'border-green-700', text: 'text-green-300', label: 'text-green-400' },
    system: { bg: 'bg-yellow-900/20', border: 'border-yellow-800', text: 'text-yellow-300', label: 'text-yellow-500' },
    tool: { bg: 'bg-purple-900/20', border: 'border-purple-800', text: 'text-purple-300', label: 'text-purple-400' },
  };

  return (
    <div className="flex h-full gap-0">
      {/* Left: conversation list */}
      <div className="w-64 flex-shrink-0 border-r border-border overflow-y-auto scrollbar-thin">
        <div className="p-3 border-b border-border">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Conversations</h3>
          <span className="text-gray-600 text-xs">{chats.length} total</span>
        </div>
        {chats.map(c => (
          <button
            key={c.key}
            onClick={() => setSelectedChat(c.key)}
            className={`w-full text-left px-3 py-2 border-b border-border/50 transition text-xs ${
              selectedChat === c.key
                ? 'bg-accent/10 border-l-2 border-l-accent'
                : 'hover:bg-bg-card'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-gray-300 truncate">
                {c.participants && Object.values(c.participants).some(v => v !== Object.keys(c.participants)[0])
                  ? Object.values(c.participants).join(', ')
                  : c.channel_id}
              </span>
              <span className="text-gray-600">{c.platform}</span>
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-gray-500">{c.turn_count} turns</span>
              <span className="text-gray-600">{formatDate(c.last_activity)} {formatTime(c.last_activity)}</span>
            </div>
            {c.total_cost > 0 && (
              <span className="text-gray-600">${c.total_cost.toFixed(4)}</span>
            )}
          </button>
        ))}
        {chats.length === 0 && (
          <p className="text-gray-600 text-xs p-3">No conversations yet</p>
        )}
      </div>

      {/* Right: message view */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedChat && (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">
            Select a conversation
          </div>
        )}
        {selectedChat && loading && !chatData && (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">
            Loading...
          </div>
        )}
        {selectedChat && chatData && (
          <>
            {/* Chat header */}
            <div className="px-4 py-2 border-b border-border flex items-center gap-3 text-xs">
              <span className="text-accent font-semibold">Swayambhu</span>
              {Object.keys(participants).length > 0 && (
                <>
                  <span className="text-gray-600">&</span>
                  <span className="text-blue-400 font-semibold">{Object.values(participants).join(', ')}</span>
                </>
              )}
              <span className="text-gray-600">|</span>
              <span className="text-gray-500">{chatData.turn_count || 0} turns</span>
              <span className="text-gray-600">|</span>
              <span className="text-gray-500">${(chatData.total_cost || 0).toFixed(4)}</span>
              {chatData.source_session && (
                <>
                  <span className="text-gray-600">|</span>
                  <span className="text-accent text-xs">from {chatData.source_session}</span>
                </>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-2">
              {(chatData.messages || []).slice().reverse().map((msg, i) => {
                const rc = roleColors[msg.role] || roleColors.system;
                const isToolResult = msg.role === 'tool';
                return (
                  <div key={i} className={`${rc.bg} border ${rc.border} rounded px-3 py-2 text-xs fade-in`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`font-semibold ${rc.label}`}>
                        {msg.role === 'assistant' ? 'Swayambhu'
                          : msg.role === 'user' ? (participants[msg.userId] || msg.userId || 'user')
                          : msg.role}
                      </span>
                      {msg.ts && <span className="text-gray-600 ml-auto">{formatTime(msg.ts)}</span>}
                      {msg.source_session && (
                        <span className="text-accent text-[10px]">via {msg.source_session}</span>
                      )}
                    </div>
                    {isToolResult ? (
                      <pre className={`${rc.text} whitespace-pre-wrap break-all`}>
                        {typeof msg.content === 'string' ? msg.content.slice(0, 500) : JSON.stringify(msg.content, null, 2).slice(0, 500)}
                      </pre>
                    ) : msg.tool_calls ? (
                      <div className="space-y-1">
                        {msg.content && <p className={rc.text}>{msg.content}</p>}
                        {msg.tool_calls.map((tc, j) => (
                          <div key={j} className="bg-purple-900/20 border border-purple-800 rounded px-2 py-1">
                            <span className="text-purple-400 font-semibold">{tc.function?.name || tc.name}</span>
                            <pre className="text-purple-300 text-[10px] mt-0.5 whitespace-pre-wrap break-all">
                              {typeof tc.function?.arguments === 'string'
                                ? tc.function.arguments.slice(0, 300)
                                : JSON.stringify(tc.function?.arguments, null, 2).slice(0, 300)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className={`${rc.text} whitespace-pre-wrap`}>{msg.content}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
