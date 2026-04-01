/**
 * Widget iframe content — minimal chat UI for tenant embed.
 *
 * This React component renders inside the iframe created by embed.ts.
 * It authenticates with the tenant's channel token, connects to the
 * AgentVBX API (HTTP or WebSocket), and renders a simple chat interface.
 *
 * Props come from URL query params: ?tenant=slug&token=tok_xxx
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

interface WidgetFrameProps {
  tenantSlug: string;
  channelToken: string;
  apiBaseUrl?: string;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function WidgetFrame({ tenantSlug, channelToken, apiBaseUrl }: WidgetFrameProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const baseUrl = apiBaseUrl ?? inferApiBaseUrl();

  // ─── WebSocket Connection ───────────────────────────────────────────

  useEffect(() => {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Listen for messages completed for this tenant
        if (
          data.type === 'message:completed' &&
          data.data?.tenant_id === tenantSlug
        ) {
          const msg: ChatMessage = {
            id: data.data.message_id ?? crypto.randomUUID(),
            role: 'assistant',
            text: data.data.response ?? data.data.text ?? '',
            timestamp: data.timestamp ?? new Date().toISOString(),
          };
          setMessages((prev) => [...prev, msg]);
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    return () => {
      ws.close();
    };
  }, [baseUrl, tenantSlug]);

  // ─── Load Message History ────────────────────────────────────────────

  useEffect(() => {
    if (!tenantSlug) return;

    fetch(`${baseUrl}/api/v1/messages/${encodeURIComponent(tenantSlug)}?limit=50`, {
      headers: {
        'Content-Type': 'application/json',
        ...(channelToken ? { Authorization: `Bearer ${channelToken}` } : {}),
      },
    })
      .then(res => res.ok ? res.json() : Promise.reject(res.status))
      .then((data: { messages?: Array<{ id: string; direction: string; content: string; timestamp: string }> }) => {
        if (data.messages && data.messages.length > 0) {
          const historicMessages: ChatMessage[] = data.messages
            .reverse() // getHistory returns newest first; show oldest first
            .map((msg) => ({
              id: msg.id,
              role: (msg.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
              text: msg.content,
              timestamp: msg.timestamp,
            }));
          setMessages((prev) => [...historicMessages, ...prev]);
        }
      })
      .catch((err) => {
        // History load failure is non-fatal — widget still works without it
        console.warn('[AgentVBX Widget] Failed to load message history:', err);
      })
      .finally(() => {
        setHistoryLoaded(true);
      });
  }, [baseUrl, tenantSlug, channelToken]);

  // ─── Auto-scroll ────────────────────────────────────────────────────

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ─── Send Message ───────────────────────────────────────────────────

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);

    try {
      await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(channelToken ? { Authorization: `Bearer ${channelToken}` } : {}),
        },
        body: JSON.stringify({
          tenant_id: tenantSlug,
          channel: 'app',
          from: 'widget-user',
          to: 'orchestrator',
          text,
        }),
      });
    } catch (err) {
      console.error('[AgentVBX Widget] Send failed:', err);
    } finally {
      setSending(false);
    }
  }, [input, sending, baseUrl, tenantSlug, channelToken]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerDot(connected)} />
        <span style={styles.headerTitle}>Chat</span>
      </div>

      {/* Messages */}
      <div style={styles.messagesArea}>
        {messages.length === 0 && (
          <div style={styles.emptyState}>
            {historyLoaded ? 'Send a message to get started.' : 'Loading...'}
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={msg.role === 'user' ? styles.userBubble : styles.assistantBubble}
          >
            {msg.text}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={styles.inputArea}>
        <textarea
          style={styles.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          disabled={sending}
        />
        <button
          style={styles.sendButton}
          onClick={sendMessage}
          disabled={sending || !input.trim()}
          aria-label="Send"
        >
          &#9654;
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function inferApiBaseUrl(): string {
  // In iframe context, parent origin may differ. Use widget host or env.
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const host = params.get('api') ?? window.location.origin;
    return host;
  }
  return 'http://localhost:3000';
}

// ─── Inline Styles ──────────────────────────────────────────────────────────

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100vh',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '14px',
    background: '#fff',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    borderBottom: '1px solid #e5e7eb',
    background: '#6366f1',
    color: '#fff',
    borderRadius: '12px 12px 0 0',
  },
  headerDot: (connected: boolean) => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: connected ? '#4ade80' : '#f87171',
  }),
  headerTitle: {
    fontWeight: 600 as const,
  },
  messagesArea: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  emptyState: {
    color: '#9ca3af',
    textAlign: 'center' as const,
    marginTop: '40px',
  },
  userBubble: {
    alignSelf: 'flex-end' as const,
    background: '#6366f1',
    color: '#fff',
    padding: '8px 12px',
    borderRadius: '12px 12px 4px 12px',
    maxWidth: '80%',
    wordBreak: 'break-word' as const,
  },
  assistantBubble: {
    alignSelf: 'flex-start' as const,
    background: '#f3f4f6',
    color: '#111827',
    padding: '8px 12px',
    borderRadius: '12px 12px 12px 4px',
    maxWidth: '80%',
    wordBreak: 'break-word' as const,
  },
  inputArea: {
    display: 'flex',
    gap: '8px',
    padding: '12px 16px',
    borderTop: '1px solid #e5e7eb',
  },
  textarea: {
    flex: 1,
    resize: 'none' as const,
    border: '1px solid #d1d5db',
    borderRadius: '8px',
    padding: '8px 12px',
    fontSize: '14px',
    outline: 'none',
    fontFamily: 'inherit',
  },
  sendButton: {
    width: '40px',
    height: '40px',
    border: 'none',
    borderRadius: '8px',
    background: '#6366f1',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
};

export default WidgetFrame;
