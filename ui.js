// Utilitários de formatação e o layout das páginas.
const TZ = 'America/Sao_Paulo';

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hoje() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function agora() { return new Date().toISOString(); }

function addDias(iso, n) {
  if (!iso) return null;
  const d = new Date(iso.slice(0, 10) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n));
  return d.toISOString().slice(0, 10);
}
function addDiasUteis(iso, n) {
  if (!iso) return null;
  const d = new Date(iso.slice(0, 10) + 'T12:00:00Z');
  let k = 0;
  while (k < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) k++;
  }
  return d.toISOString().slice(0, 10);
}
function diasEntre(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}
// Dia (AAAA-MM-DD) de um carimbo ISO, no fuso de São Paulo.
function diaDe(ts) {
  if (!ts) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

function data(v) {
  if (!v) return '';
  const d = diaDe(v);
  const [y, m, dd] = d.split('-');
  return `${dd}/${m}/${y}`;
}
function dataHora(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}
function moeda(v) {
  if (v === null || v === undefined || v === '') return '—';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
// Aceita "1.234,56", "1234,56", "1234.56", "R$ 1.234,56".
function lerMoeda(s) {
  if (s === undefined || s === null) return null;
  let t = String(s).replace(/R\$|\s/g, '').trim();
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function lerData(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
function soDigitos(s) { return String(s || '').replace(/\D/g, ''); }
function waNumero(s) {
  let d = soDigitos(s);
  if (!d) return '';
  if (d.length <= 11) d = '55' + d;
  return d;
}

function classeStatus(s) {
  return {
    'A orçar': 'cinza', 'Orçado': 'amarelo', 'Link enviado': 'laranja', 'Revisar': 'vermelho',
    'Comprado': 'azul', 'Entregue': 'verde-agua', 'Concluído': 'verde', 'Cancelado': 'riscado',
    'Não precisa': 'cinza', 'Pendente': 'laranja', 'Agendada': 'azul', 'Concluída': 'verde',
    'Em andamento': 'azul', 'Bloqueada': 'vermelho', 'Em montagem': 'azul', 'Entregue ao proprietário': 'verde',
  }[s] || 'cinza';
}
function pill(s) { return `<span class="pill ${classeStatus(s)}">${esc(s)}</span>`; }

function options(lista, atual) {
  return lista.map(o => `<option${o === atual ? ' selected' : ''}>${esc(o)}</option>`).join('');
}

function layout({ titulo, usuario, corpo, aviso }) {
  const nav = usuario ? `
    <nav class="topo">
      <a href="/" class="marca"><img src="/public/logo-stay22-branca.png" alt="Stay22"></a>
      <div class="menu">
        ${usuario.papel === 'admin' ? '<a href="/">Unidades</a><a href="/proprietarios">Proprietários</a>' : '<a href="/">Minha unidade</a>'}
        <a href="/conta">Minha conta</a>
        <form method="post" action="/sair"><button class="link">Sair</button></form>
      </div>
    </nav>` : '';
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(titulo)} · Stay22</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/public/style.css">
<link rel="icon" href="/public/logo-stay22-marrom.png">
</head><body>
${nav}
<main>
${aviso ? `<div class="aviso">${esc(aviso)}</div>` : ''}
${corpo}
</main>
<footer>Stay22 · Gestão de locação por temporada · São Lourenço/MG</footer>
<script src="/public/app.js" defer></script>
</body></html>`;
}

module.exports = {
  esc, hoje, agora, addDias, addDiasUteis, diasEntre, diaDe, data, dataHora, moeda, lerMoeda, lerData,
  soDigitos, waNumero, pill, classeStatus, options, layout,
};
