/**
 * Feedback Widget — floating button with bug report / feature request modal.
 * Submissions POST to the n8n /feedback webhook, which verifies membership
 * server-side and notifies the owner on WhatsApp. No database client in the browser.
 *
 * Visual: Bobina Térmica (classes em styles.css). O conteúdo digitado pelo
 * membro nunca passa por innerHTML.
 */
const FeedbackWidget = (function() {
  const TOOL_SLUG = 'despesas-ia';
  let selectedType = 'feature';
  let lastFocus = null;

  function getMemberEmail() {
    var session = window.MembershipGate ? MembershipGate.getSession() : null;
    return session ? session.email : null;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  // O botão mora no cabeçalho do estúdio (ao lado de chaves e sair) em vez de
  // flutuar sobre a página: assim nunca cobre um cartão nem a barra de ações.
  function createWidget() {
    if (document.getElementById('feedback-btn')) return;
    var btn = el('button', 'btn-icon feedback-btn');
    btn.id = 'feedback-btn';
    btn.type = 'button';
    btn.title = 'Enviar feedback';
    btn.setAttribute('aria-label', 'Enviar feedback');
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    btn.addEventListener('click', showModal);
    var bar = document.querySelector('#app-screen .header-right');
    var logout = document.getElementById('logout-btn');
    if (bar && logout && logout.parentNode === bar) {
      bar.insertBefore(btn, logout);
    } else {
      btn.classList.add('is-floating');
      document.body.appendChild(btn);
    }
  }

  function setType(modal, type) {
    selectedType = type;
    modal.querySelectorAll('.fb-type-btn').forEach(function(b) {
      var on = b.dataset.type === type;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function showModal() {
    lastFocus = document.activeElement;
    var existing = document.getElementById('feedback-modal');
    if (existing) {
      existing.hidden = false;
      var ta = document.getElementById('feedback-text');
      if (ta) ta.focus();
      return;
    }

    var modal = el('div', 'modal feedback-modal');
    modal.id = 'feedback-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'feedback-title');

    var overlay = el('div', 'modal-overlay');
    overlay.id = 'feedback-overlay';

    var box = el('div', 'modal-content');
    var head = el('div', 'modal-header');
    var title = el('h3', '', 'Enviar feedback');
    title.id = 'feedback-title';
    var close = el('button', 'btn-icon');
    close.id = 'feedback-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Fechar');
    close.textContent = '×';
    head.appendChild(title);
    head.appendChild(close);

    var types = el('div', 'fb-types');
    var bug = el('button', 'fb-type-btn', 'Encontrei um problema');
    bug.type = 'button';
    bug.dataset.type = 'bug';
    var idea = el('button', 'fb-type-btn', 'Tenho uma sugestão');
    idea.type = 'button';
    idea.dataset.type = 'feature';
    types.appendChild(bug);
    types.appendChild(idea);

    var label = el('label', 'sr-only', 'Sua mensagem');
    label.setAttribute('for', 'feedback-text');
    var text = el('textarea');
    text.id = 'feedback-text';
    text.rows = 5;
    text.maxLength = 2000;
    text.placeholder = 'Conte o que aconteceu ou o que você gostaria de ver aqui…';

    var send = el('button', 'btn-primary');
    send.id = 'feedback-send';
    send.type = 'button';
    var sendText = el('span', 'fb-btn-text', 'Enviar');
    var sendLoading = el('span', 'fb-btn-loading', 'Enviando…');
    sendLoading.hidden = true;
    send.appendChild(sendText);
    send.appendChild(sendLoading);

    var status = el('p', 'fb-status');
    status.id = 'feedback-status';
    status.setAttribute('role', 'status');
    status.hidden = true;

    box.appendChild(head);
    box.appendChild(types);
    box.appendChild(label);
    box.appendChild(text);
    box.appendChild(send);
    box.appendChild(status);
    modal.appendChild(overlay);
    modal.appendChild(box);
    document.body.appendChild(modal);

    setType(modal, 'feature');
    bug.addEventListener('click', function() { setType(modal, 'bug'); });
    idea.addEventListener('click', function() { setType(modal, 'feature'); });
    overlay.addEventListener('click', closeModal);
    close.addEventListener('click', closeModal);
    modal.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

    send.addEventListener('click', async function() {
      var message = text.value.trim();

      function show(kind, msg) {
        status.className = 'fb-status ' + kind;
        status.textContent = msg;
        status.hidden = false;
      }

      if (!message) {
        show('bad', 'Escreva a sua mensagem antes de enviar.');
        return;
      }

      send.disabled = true;
      sendText.hidden = true;
      sendLoading.hidden = false;

      try {
        var base = (window.APP_CONFIG && window.APP_CONFIG.n8nWebhookBase) || '';
        var resp = await fetch(base + '/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool_slug: TOOL_SLUG,
            member_email: getMemberEmail(),
            type: selectedType,
            message: message
          })
        });

        var result = {};
        try { result = await resp.json(); } catch {}

        if (result.success) {
          show('good', 'Feedback enviado. Obrigado, Maestro!');
          text.value = '';
          setTimeout(closeModal, 2000);
        } else {
          show('bad', 'Não foi possível enviar agora. Tente novamente.');
        }
      } catch {
        show('bad', 'Não foi possível enviar agora. Tente novamente.');
      } finally {
        send.disabled = false;
        sendText.hidden = false;
        sendLoading.hidden = true;
      }
    });

    text.focus();
  }

  function closeModal() {
    var modal = document.getElementById('feedback-modal');
    if (modal) modal.hidden = true;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  function init() {
    var app = document.getElementById('app-screen');
    if (app && app.classList.contains('active')) {
      createWidget();
      return;
    }
    // O botão só aparece dentro do estúdio (nunca sobre o login).
    var observer = new MutationObserver(function() {
      var a = document.getElementById('app-screen');
      if (a && a.classList.contains('active')) {
        createWidget();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  return { init: init };
})();

window.FeedbackWidget = FeedbackWidget;

document.addEventListener('DOMContentLoaded', function() {
  setTimeout(function() { FeedbackWidget.init(); }, 300);
});
