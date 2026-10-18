/**
 * Pedido de exclusão de dados (LGPD). Envia para o webhook request-deletion do
 * n8n, que registra o pedido no servidor. O navegador não fala com banco de dados.
 * Em arquivo próprio porque o CSP desta ferramenta proíbe scripts inline.
 */
(function () {
  var form = document.getElementById('deletion-form');
  if (!form) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var emailEl = document.getElementById('del-email');
    var email = emailEl.value.trim().toLowerCase();
    var phone = document.getElementById('del-phone').value.replace(/\D/g, '');
    var reason = document.getElementById('del-reason').value.trim();
    var submitBtn = document.getElementById('del-submit');
    var errorEl = document.getElementById('del-error');
    var successEl = document.getElementById('del-success');
    var btnText = submitBtn.querySelector('.btn-text');
    var btnLoading = submitBtn.querySelector('.btn-loading');

    function fail(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }

    errorEl.hidden = true;
    successEl.hidden = true;

    if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) {
      fail('Informe o e-mail cadastrado na sua compra.');
      emailEl.focus();
      return;
    }
    if (phone && (phone.length < 8 || phone.length > 15)) {
      fail('Confira o número de WhatsApp (com DDD) ou deixe o campo vazio.');
      return;
    }

    submitBtn.disabled = true;
    btnText.hidden = true;
    btnLoading.hidden = false;

    try {
      var base = (window.APP_CONFIG && window.APP_CONFIG.n8nWebhookBase) || '';
      var resp = await fetch(base + '/request-deletion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, phone: phone, reason: reason ? reason.slice(0, 1000) : null })
      });
      var result = {};
      try { result = await resp.json(); } catch (err) {}

      if (result && result.success) {
        successEl.textContent = 'Solicitação enviada. Vamos processar em até 15 dias úteis.';
        successEl.hidden = false;
        form.reset();
      } else {
        fail('Não foi possível registrar o pedido agora. Tente de novo ou escreva para contato@lyraarte.com.');
      }
    } catch (err) {
      fail('Erro de conexão. Verifique a sua internet e tente novamente.');
    } finally {
      submitBtn.disabled = false;
      btnText.hidden = false;
      btnLoading.hidden = true;
    }
  });
})();
