// Botões "Copiar" (cupom, endereço, destinatário).
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copiar]');
  if (!b) return;
  var texto = b.getAttribute('data-copiar');
  var feito = function () {
    var antes = b.textContent;
    b.textContent = 'Copiado!'; b.classList.add('copiado');
    setTimeout(function () { b.textContent = antes; b.classList.remove('copiado'); }, 1800);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(texto).then(feito, function () { fallback(); });
  } else { fallback(); }
  function fallback() {
    var t = document.createElement('textarea');
    t.value = texto; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); feito(); } catch (_) {}
    document.body.removeChild(t);
  }
});
