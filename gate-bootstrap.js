/**
 * gate-bootstrap — captura um clique em "Verificar acesso" que aconteça antes
 * de o gate remoto (gate.maestrosdaia.com) terminar de carregar, para que o
 * primeiro clique nunca se perca. O gate desarma este listener ao iniciar e
 * repete o envio capturado.
 *
 * Fica em arquivo próprio (e não inline no <head>) para que o CSP desta
 * ferramenta possa proibir scripts inline.
 */
(function () {
  function capture(e) {
    var f = e.target;
    if (f && f.id === 'gate-form' && !window.MembershipGate) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.__gateEarlySubmit = true;
    }
  }
  window.addEventListener('submit', capture, true);
  window.__gateBootstrapDisarm = function () {
    window.removeEventListener('submit', capture, true);
  };
})();

/**
 * Quem já entrou antes: enquanto o gate remoto confere a sessão guardada no servidor,
 * a tela mostra "Conferindo o seu acesso…" no lugar do formulário, em vez de piscar o
 * login por um instante. É só aparência — quem decide o acesso continua sendo o
 * backend; se ele negar, o formulário volta. O estado termina assim que o gate troca
 * (ou confirma) a tela, e nunca dura mais de 8 s.
 */
(function () {
  var root = document.documentElement;
  var hasSession = false;
  try { hasSession = !!localStorage.getItem('maestria_member_session'); } catch (e) {}
  if (!hasSession) return;
  root.classList.add('is-gate-checking');
  var observer = null;
  var timer = setTimeout(done, 8000);
  function done() {
    root.classList.remove('is-gate-checking');
    clearTimeout(timer);
    if (observer) { observer.disconnect(); observer = null; }
  }
  function watch() {
    var screens = document.querySelectorAll('.screen');
    if (!screens.length || !window.MutationObserver) { done(); return; }
    observer = new MutationObserver(done);
    for (var i = 0; i < screens.length; i++) observer.observe(screens[i], { attributes: true, attributeFilter: ['class'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();
