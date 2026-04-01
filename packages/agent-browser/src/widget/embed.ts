/**
 * Tenant widget embed script.
 *
 * Usage:
 *   <script src="https://widget.spokestack.io/embed.js"
 *           data-tenant-slug="acme"
 *           data-channel-token="tok_xxx"></script>
 *
 * This script injects a chat widget iframe into the host page.
 * Vanilla JS, no dependencies, <5KB output target.
 */

(function () {
  // Find our own script tag to read data attributes
  const scripts = document.querySelectorAll('script[data-tenant-slug]');
  const scriptEl = scripts[scripts.length - 1] as HTMLScriptElement | undefined;
  if (!scriptEl) return;

  const tenantSlug = scriptEl.getAttribute('data-tenant-slug');
  const channelToken = scriptEl.getAttribute('data-channel-token') ?? '';
  if (!tenantSlug) {
    console.error('[AgentVBX] Missing data-tenant-slug attribute on embed script');
    return;
  }

  // Determine widget host from script src or env
  const scriptSrc = scriptEl.getAttribute('src') ?? '';
  const widgetHost = scriptSrc
    ? new URL(scriptSrc).origin
    : (typeof window !== 'undefined' && (window as any).__AGENTVBX_WIDGET_HOST__)
      ?? 'https://widget.spokestack.io';

  // Widget state
  let isOpen = false;
  let iframe: HTMLIFrameElement | null = null;

  // ─── Styles ──────────────────────────────────────────────────────────

  const BUTTON_SIZE = 56;
  const IFRAME_WIDTH = 380;
  const IFRAME_HEIGHT = 560;

  function injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      #agentvbx-widget-btn {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: ${BUTTON_SIZE}px;
        height: ${BUTTON_SIZE}px;
        border-radius: 50%;
        background: #6366f1;
        border: none;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s ease;
      }
      #agentvbx-widget-btn:hover { transform: scale(1.08); }
      #agentvbx-widget-btn svg {
        width: 28px;
        height: 28px;
        fill: white;
      }
      #agentvbx-widget-frame {
        position: fixed;
        bottom: 88px;
        right: 20px;
        width: ${IFRAME_WIDTH}px;
        height: ${IFRAME_HEIGHT}px;
        border: none;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.18);
        z-index: 2147483647;
        display: none;
        background: white;
      }
      #agentvbx-widget-frame.open { display: block; }
      @media (max-width: 420px) {
        #agentvbx-widget-frame {
          width: calc(100vw - 16px);
          height: calc(100vh - 120px);
          right: 8px;
          bottom: 80px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── DOM ─────────────────────────────────────────────────────────────

  function createButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.id = 'agentvbx-widget-btn';
    btn.setAttribute('aria-label', 'Open chat');
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg>`;
    btn.addEventListener('click', toggle);
    return btn;
  }

  function createIframe(): HTMLIFrameElement {
    const frame = document.createElement('iframe');
    frame.id = 'agentvbx-widget-frame';
    frame.src = `${widgetHost}/widget?tenant=${encodeURIComponent(tenantSlug!)}&token=${encodeURIComponent(channelToken)}`;
    frame.allow = 'microphone';
    frame.setAttribute('title', 'Chat Widget');
    return frame;
  }

  function toggle(): void {
    isOpen = !isOpen;
    if (iframe) {
      iframe.classList.toggle('open', isOpen);
    }
  }

  // ─── Init ────────────────────────────────────────────────────────────

  function init(): void {
    injectStyles();
    iframe = createIframe();
    const btn = createButton();
    document.body.appendChild(iframe);
    document.body.appendChild(btn);
  }

  // Run on DOMContentLoaded or immediately if already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
