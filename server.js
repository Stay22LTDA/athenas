// Painel de montagem Stay22 — servidor.
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const {
  db, DATA_DIR, segredo, ITENS_PADRAO, ETAPAS_PADRAO,
  STATUS_ITEM, STATUS_INSTALACAO, STATUS_ETAPA, FORMAS_PAGAMENTO, TIPOS_ANEXO,
} = require('./db');
const U = require('./ui');
const { esc, moeda, data, pill, options, layout } = U;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'none'; form-action 'self' https://wa.me; frame-ancestors 'none'",
  });
  next();
});

// ---------- Senhas e sessão ----------
const SEGREDO = segredo();
function hashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  return sal + ':' + crypto.scryptSync(senha, sal, 64).toString('hex');
}
function confereSenha(senha, guardado) {
  const [sal, h] = String(guardado).split(':');
  if (!sal || !h) return false;
  const calc = crypto.scryptSync(senha, sal, 64);
  const ref = Buffer.from(h, 'hex');
  return ref.length === calc.length && crypto.timingSafeEqual(ref, calc);
}
function senhaTemporaria() {
  const letras = 'abcdefghjkmnpqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 4; i++) s += letras[crypto.randomInt(letras.length)];
  return 'stay' + s + crypto.randomInt(1000, 9999);
}
function assinar(v) { return crypto.createHmac('sha256', SEGREDO).update(v).digest('base64url'); }
function criarSessao(res, uid) {
  const corpo = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 30 * 86400000 })).toString('base64url');
  res.cookie('s22', corpo + '.' + assinar(corpo), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400000, path: '/',
  });
}
function lerCookie(req, nome) {
  const c = req.headers.cookie || '';
  for (const parte of c.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return v.join('=');
  }
  return null;
}
app.use((req, res, next) => {
  req.usuario = null;
  const v = lerCookie(req, 's22');
  if (v && v.includes('.')) {
    const [corpo, sig] = v.split('.');
    const esperado = assinar(corpo);
    if (sig && sig.length === esperado.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) {
      try {
        const s = JSON.parse(Buffer.from(corpo, 'base64url').toString());
        if (s.exp > Date.now()) {
          const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND ativo = 1').get(s.uid);
          if (u) req.usuario = u;
        }
      } catch (_) { /* sessão inválida */ }
    }
  }
  next();
});

const MSGS = {
  salvo: 'Alterações salvas.', comprado: 'Compra registrada. Obrigado!', revisar: 'Pedido de revisão enviado à Stay22.',
  anexo: 'Arquivo anexado.', senha: 'Senha alterada.', criada: 'Unidade criada.', item: 'Item adicionado.',
  excluido: 'Item excluído.', trocar: 'Bem-vindo! Por segurança, crie uma senha sua antes de continuar.',
  enviado: 'Link marcado como enviado.',
};
function aviso(req) { return MSGS[req.query.msg] || ''; }

function pagina(req, res, titulo, corpo, status = 200) {
  res.status(status).type('html').send(layout({ titulo, usuario: req.usuario, corpo, aviso: aviso(req) }));
}
function erro(req, res, status, texto) {
  pagina(req, res, 'Ops', `<section class="cartao"><h1>Ops</h1><p>${esc(texto)}</p><p><a href="/">Voltar</a></p></section>`, status);
}

function exigirLogin(req, res, next) {
  if (!req.usuario) return res.redirect('/entrar?volta=' + encodeURIComponent(req.originalUrl));
  if (req.usuario.trocar_senha && req.method === 'GET' && req.path !== '/conta') return res.redirect('/conta?msg=trocar');
  next();
}
function exigirAdmin(req, res, next) {
  if (!req.usuario || req.usuario.papel !== 'admin') return erro(req, res, 403, 'Acesso restrito à equipe Stay22.');
  next();
}
const ehAdmin = req => req.usuario && req.usuario.papel === 'admin';

function unidadeComAcesso(req, id) {
  const u = db.prepare('SELECT * FROM unidades WHERE id = ?').get(Number(id));
  if (!u) return null;
  if (ehAdmin(req) || u.proprietario_id === req.usuario.id) return u;
  return null;
}
function itemComAcesso(req, id) {
  const it = db.prepare('SELECT * FROM itens WHERE id = ?').get(Number(id));
  if (!it) return null;
  const u = unidadeComAcesso(req, it.unidade_id);
  return u ? { it, u } : null;
}

function registrar(unidadeId, itemId, usuarioId, acao, detalhes) {
  db.prepare('INSERT INTO historico (unidade_id, item_id, usuario_id, acao, detalhes, criado_em) VALUES (?,?,?,?,?,?)')
    .run(unidadeId, itemId || null, usuarioId || null, acao, detalhes || null, U.agora());
}

// Limite simples de tentativas de login.
const tentativas = new Map();
function bloqueado(chave) {
  const t = tentativas.get(chave);
  if (!t) return false;
  if (Date.now() - t.inicio > 15 * 60000) { tentativas.delete(chave); return false; }
  return t.n >= 8;
}
function falhou(chave) {
  const t = tentativas.get(chave) || { n: 0, inicio: Date.now() };
  t.n++; tentativas.set(chave, t);
}

// ---------- Cálculos ----------
function entregaPrevista(u) { return u.data_assinatura ? U.addDias(u.data_assinatura, u.prazo_dias) : null; }
function prazoAprovacao(it) { return it.link_enviado_em ? U.addDiasUteis(U.diaDe(it.link_enviado_em), 3) : null; }

function resumo(u) {
  const hoje = U.hoje();
  const itens = db.prepare('SELECT * FROM itens WHERE unidade_id = ? ORDER BY ordem, id').all(u.id);
  const ativos = itens.filter(i => i.status !== 'Cancelado');
  const soma = (l, f) => l.reduce((a, i) => a + (Number(i[f]) || 0), 0);
  const parcelas = db.prepare('SELECT * FROM parcelas WHERE unidade_id = ? ORDER BY ordem, id').all(u.id);
  const r = {
    itens, parcelas,
    total: ativos.length,
    orcado: soma(ativos, 'valor_orcado'),
    pago: soma(itens, 'valor_pago'),
    comprados: ativos.filter(i => ['Comprado', 'Entregue', 'Concluído'].includes(i.status)).length,
    concluidos: ativos.filter(i => i.status === 'Concluído').length,
    aguardando: ativos.filter(i => i.status === 'Link enviado'),
    revisar: ativos.filter(i => i.status === 'Revisar'),
    aprovacaoVencida: ativos.filter(i => i.status === 'Link enviado' && prazoAprovacao(i) < hoje),
    atrasadas: ativos.filter(i => i.previsao_entrega && i.previsao_entrega < hoje && !i.entregue_em && ['Comprado'].includes(i.status)),
    instalacoes: ativos.filter(i => ['Pendente', 'Agendada'].includes(i.instalacao)),
    ofertasVencendo: ativos.filter(i => i.status === 'Link enviado' && i.oferta_ate && U.diasEntre(hoje, i.oferta_ate) <= 1 && i.oferta_ate >= hoje),
    pacoteRecebido: parcelas.filter(p => p.pago_em).reduce((a, p) => a + p.valor, 0),
    pacoteTotal: parcelas.reduce((a, p) => a + p.valor, 0),
    parcelasVencidas: parcelas.filter(p => !p.pago_em && p.vencimento && p.vencimento < hoje),
    entrega: entregaPrevista(u),
  };
  r.saldo = u.verba_estimada - r.pago;
  r.teto = u.verba_estimada * 1.3;
  r.progresso = r.total ? Math.round((r.comprados / r.total) * 100) : 0;
  r.diasRestantes = r.entrega ? U.diasEntre(hoje, r.entrega) : null;
  return r;
}

function baseUrl(req) { return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`; }
function primeiroNome(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

// ---------- Primeiro acesso, entrar, sair ----------
function semUsuarios() { return db.prepare('SELECT COUNT(*) n FROM usuarios').get().n === 0; }

app.get('/configurar', (req, res) => {
  if (!semUsuarios()) return res.redirect('/entrar');
  pagina(req, res, 'Primeiro acesso', `
  <section class="cartao estreito">
    <img class="logo-login" src="/public/logo-stay22-marrom.png" alt="Stay22">
    <h1>Primeiro acesso</h1>
    <p class="sub">Crie a conta de administração da Stay22. Esta tela só aparece enquanto não houver nenhuma conta.</p>
    <form method="post" class="form">
      <label>Nome<input name="nome" required></label>
      <label>E-mail<input name="email" type="email" required></label>
      <label>WhatsApp<input name="whatsapp"></label>
      <label>Senha (mínimo 8 caracteres)<input name="senha" type="password" minlength="8" required></label>
      <button>Criar conta</button>
    </form>
  </section>`);
});
app.post('/configurar', (req, res) => {
  if (!semUsuarios()) return res.redirect('/entrar');
  const { nome, email, whatsapp, senha } = req.body;
  if (!nome || !email || !senha || senha.length < 8) return erro(req, res, 400, 'Preencha nome, e-mail e uma senha de pelo menos 8 caracteres.');
  const r = db.prepare('INSERT INTO usuarios (nome, email, whatsapp, senha_hash, papel, criado_em) VALUES (?,?,?,?,?,?)')
    .run(nome.trim(), email.trim(), whatsapp || null, hashSenha(senha), 'admin', U.agora());
  criarSessao(res, Number(r.lastInsertRowid));
  res.redirect('/');
});

app.get('/entrar', (req, res) => {
  if (semUsuarios()) return res.redirect('/configurar');
  if (req.usuario) return res.redirect('/');
  const falha = req.query.erro ? '<p class="erro">E-mail ou senha incorretos.</p>' : '';
  const trava = req.query.trava ? '<p class="erro">Muitas tentativas. Aguarde 15 minutos e tente de novo.</p>' : '';
  pagina(req, res, 'Entrar', `
  <section class="cartao estreito">
    <img class="logo-login" src="/public/logo-stay22-marrom.png" alt="Stay22">
    <h1>Painel de montagem</h1>
    <p class="sub">Acompanhe a montagem da sua unidade, item por item.</p>
    ${falha}${trava}
    <form method="post" class="form">
      <input type="hidden" name="volta" value="${esc(req.query.volta || '/')}">
      <label>E-mail<input name="email" type="email" autocomplete="username" required></label>
      <label>Senha<input name="senha" type="password" autocomplete="current-password" required></label>
      <button>Entrar</button>
    </form>
    <p class="nota">Esqueceu a senha? Fale com a Stay22 pelo WhatsApp (35) 98846-4111.</p>
  </section>`);
});
app.post('/entrar', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const chave = req.ip + '|' + email;
  if (bloqueado(chave)) return res.redirect('/entrar?trava=1');
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ? AND ativo = 1').get(email);
  if (!u || !confereSenha(String(req.body.senha || ''), u.senha_hash)) { falhou(chave); return res.redirect('/entrar?erro=1'); }
  tentativas.delete(chave);
  criarSessao(res, u.id);
  let volta = String(req.body.volta || '/');
  if (!volta.startsWith('/') || volta.startsWith('//')) volta = '/';
  res.redirect(volta);
});
app.post('/sair', (req, res) => { res.clearCookie('s22', { path: '/' }); res.redirect('/entrar'); });

app.get('/saude', (req, res) => res.type('text').send('ok'));

// ---------- Minha conta ----------
app.get('/conta', exigirLogin, (req, res) => {
  const u = req.usuario;
  pagina(req, res, 'Minha conta', `
  <section class="cartao estreito">
    <h1>Minha conta</h1>
    <p class="sub">${esc(u.nome)} · ${esc(u.email)}</p>
    ${req.query.erro ? '<p class="erro">Confira a senha atual e se as duas senhas novas são iguais (mínimo 8 caracteres).</p>' : ''}
    <form method="post" action="/conta/senha" class="form">
      <label>Senha atual<input name="atual" type="password" autocomplete="current-password" required></label>
      <label>Nova senha (mínimo 8 caracteres)<input name="nova" type="password" minlength="8" autocomplete="new-password" required></label>
      <label>Repita a nova senha<input name="nova2" type="password" minlength="8" autocomplete="new-password" required></label>
      <button>Salvar nova senha</button>
    </form>
  </section>`);
});
app.post('/conta/senha', exigirLogin, (req, res) => {
  const { atual, nova, nova2 } = req.body;
  if (!confereSenha(String(atual || ''), req.usuario.senha_hash) || !nova || nova.length < 8 || nova !== nova2) return res.redirect('/conta?erro=1');
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0 WHERE id = ?').run(hashSenha(nova), req.usuario.id);
  res.redirect('/?msg=senha');
});

// ---------- Início ----------
app.get('/', exigirLogin, (req, res) => {
  if (!ehAdmin(req)) {
    const us = db.prepare('SELECT * FROM unidades WHERE proprietario_id = ? ORDER BY numero').all(req.usuario.id);
    if (us.length === 1) return res.redirect('/u/' + us[0].id + (req.query.msg ? '?msg=' + encodeURIComponent(req.query.msg) : ''));
    return pagina(req, res, 'Minhas unidades', `
      <section class="cabecalho"><h1>Olá, ${esc(primeiroNome(req.usuario.nome))}</h1></section>
      <section class="cartao">${us.length ? us.map(u => `<a class="linha-link" href="/u/${u.id}">Unidade ${esc(u.numero)} · ${esc(u.edificio)}</a>`).join('') : '<p>Nenhuma unidade vinculada à sua conta ainda.</p>'}</section>`);
  }
  painelGeral(req, res);
});

function painelGeral(req, res) {
  const unidades = db.prepare(`SELECT u.*, p.nome AS prop_nome FROM unidades u LEFT JOIN usuarios p ON p.id = u.proprietario_id ORDER BY u.edificio, u.numero`).all();
  const linhas = [];
  const alertas = [];
  for (const u of unidades) {
    const r = resumo(u);
    linhas.push(`<tr>
      <td><a href="/u/${u.id}"><strong>${esc(u.numero)}</strong></a><div class="mini">${esc(u.edificio)}</div></td>
      <td>${esc(u.prop_nome || '—')}</td>
      <td><div class="barra"><span style="width:${r.progresso}%"></span></div><div class="mini">${r.comprados}/${r.total} comprados · ${r.concluidos} concluídos</div></td>
      <td class="num">${moeda(r.pago)}<div class="mini">de ${moeda(u.verba_estimada)}</div></td>
      <td>${r.entrega ? data(r.entrega) : '—'}<div class="mini">${r.diasRestantes === null ? '' : r.diasRestantes >= 0 ? r.diasRestantes + ' dias' : Math.abs(r.diasRestantes) + ' dias de atraso'}</div></td>
      <td>${pill(u.status)}</td>
    </tr>`);
    const tag = `<a href="/u/${u.id}">Unidade ${esc(u.numero)}</a>`;
    r.aprovacaoVencida.forEach(i => alertas.push(`${tag}: <a href="/itens/${i.id}">${esc(i.nome)}</a>, link enviado em ${data(i.link_enviado_em)} e sem compra registrada (prazo de 3 dias úteis vencido)`));
    r.ofertasVencendo.forEach(i => alertas.push(`${tag}: <a href="/itens/${i.id}">${esc(i.nome)}</a>, oferta vale até ${data(i.oferta_ate)}`));
    r.revisar.forEach(i => alertas.push(`${tag}: <a href="/itens/${i.id}">${esc(i.nome)}</a>, proprietário pediu outra opção`));
    r.atrasadas.forEach(i => alertas.push(`${tag}: <a href="/itens/${i.id}">${esc(i.nome)}</a>, entrega prevista para ${data(i.previsao_entrega)} ainda não chegou`));
    r.parcelasVencidas.forEach(p => alertas.push(`${tag}: parcela "${esc(p.descricao)}" do Pacote Stay22 venceu em ${data(p.vencimento)}`));
    if (r.pago > r.teto) alertas.push(`${tag}: compras passaram de 30% acima da verba estimada; precisa de aprovação por escrito`);
  }
  pagina(req, res, 'Unidades', `
  <section class="cabecalho">
    <div><h1>Montagem das unidades</h1><p class="sub">${unidades.length} unidade(s) em acompanhamento</p></div>
    <div class="acoes"><a class="botao" href="/unidades/nova">+ Nova unidade</a><a class="botao claro" href="/proprietarios">Proprietários</a></div>
  </section>
  <section class="cartao ${alertas.length ? 'alerta' : ''}">
    <h2>Pendências</h2>
    ${alertas.length ? `<ul class="lista-alertas">${alertas.map(a => `<li>${a}</li>`).join('')}</ul>` : '<p class="mini">Nenhuma pendência no momento.</p>'}
  </section>
  <section class="cartao">
    <h2>Unidades</h2>
    ${unidades.length ? `<div class="tabela-rolagem"><table class="tabela"><thead><tr><th>Unidade</th><th>Proprietário</th><th>Compras</th><th>Pago</th><th>Entrega</th><th>Status</th></tr></thead><tbody>${linhas.join('')}</tbody></table></div>` : '<p>Nenhuma unidade cadastrada. <a href="/unidades/nova">Cadastrar a primeira</a>.</p>'}
  </section>`);
}

// ---------- Proprietários (equipe) ----------
app.get('/proprietarios', exigirLogin, exigirAdmin, (req, res) => {
  const us = db.prepare(`SELECT u.*, (SELECT group_concat(numero, ', ') FROM unidades WHERE proprietario_id = u.id) AS unidades FROM usuarios u ORDER BY papel DESC, nome`).all();
  pagina(req, res, 'Proprietários', `
  <section class="cabecalho"><div><h1>Proprietários e equipe</h1><p class="sub">Quem pode entrar no painel</p></div></section>
  <section class="cartao">
    <div class="tabela-rolagem"><table class="tabela"><thead><tr><th>Nome</th><th>E-mail (login)</th><th>WhatsApp</th><th>Unidades</th><th>Perfil</th><th></th></tr></thead><tbody>
    ${us.map(u => `<tr class="${u.ativo ? '' : 'inativo'}">
      <td>${esc(u.nome)}</td><td>${esc(u.email)}</td><td>${esc(u.whatsapp || '')}</td><td>${esc(u.unidades || '—')}</td>
      <td>${u.papel === 'admin' ? 'Equipe Stay22' : 'Proprietário'}${u.ativo ? '' : ' · desativado'}</td>
      <td class="acoes-linha">${u.id === req.usuario.id ? '' : `
        <form method="post" action="/proprietarios/${u.id}/senha"><button class="link">Gerar nova senha</button></form>
        <form method="post" action="/proprietarios/${u.id}/ativo"><button class="link">${u.ativo ? 'Desativar' : 'Reativar'}</button></form>`}
      </td></tr>`).join('')}
    </tbody></table></div>
  </section>
  <section class="cartao estreito-esq">
    <h2>Cadastrar acesso</h2>
    <form method="post" action="/proprietarios" class="form grade2">
      <label>Nome completo<input name="nome" required></label>
      <label>E-mail (será o login)<input name="email" type="email" required></label>
      <label>WhatsApp (com DDD)<input name="whatsapp" placeholder="(13) 99999-9999"></label>
      <label>Perfil<select name="papel"><option value="proprietario">Proprietário</option><option value="admin">Equipe Stay22</option></select></label>
      <button>Cadastrar e gerar senha</button>
    </form>
  </section>`);
});

function telaCredenciais(req, res, u, senha) {
  const msg = `Olá, ${primeiroNome(u.nome)}! Tudo bem?\n\nCriei seu acesso ao painel de montagem da Stay22. Por lá você acompanha cada item da sua unidade: orçamentos, links de compra, entregas e instalações.\n\nAcesse: ${baseUrl(req)}/entrar\nLogin: ${u.email}\nSenha provisória: ${senha}\n\nNo primeiro acesso o painel pede para você criar uma senha sua.\n\nQualquer dúvida, estou à disposição.\nStay22`;
  const wa = `https://wa.me/${U.waNumero(u.whatsapp)}?text=${encodeURIComponent(msg)}`;
  pagina(req, res, 'Acesso criado', `
  <section class="cartao estreito">
    <h1>Acesso de ${esc(u.nome)}</h1>
    <p class="sub">A senha provisória aparece só agora. Envie ao proprietário e feche esta tela.</p>
    <dl class="dados"><dt>Login</dt><dd>${esc(u.email)}</dd><dt>Senha provisória</dt><dd><code>${esc(senha)}</code></dd></dl>
    <a class="botao whatsapp" href="${esc(wa)}" target="_blank" rel="noopener">Enviar acesso pelo WhatsApp</a>
    <p><a href="/proprietarios">Voltar para a lista</a></p>
  </section>`);
}
app.post('/proprietarios', exigirLogin, exigirAdmin, (req, res) => {
  const { nome, email, whatsapp, papel } = req.body;
  if (!nome || !email) return erro(req, res, 400, 'Informe nome e e-mail.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email.trim())) return erro(req, res, 400, 'Já existe um acesso com esse e-mail.');
  const senha = senhaTemporaria();
  const r = db.prepare('INSERT INTO usuarios (nome, email, whatsapp, senha_hash, papel, trocar_senha, criado_em) VALUES (?,?,?,?,?,1,?)')
    .run(nome.trim(), email.trim().toLowerCase(), whatsapp || null, hashSenha(senha), papel === 'admin' ? 'admin' : 'proprietario', U.agora());
  telaCredenciais(req, res, db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(r.lastInsertRowid)), senha);
});
app.post('/proprietarios/:id/senha', exigirLogin, exigirAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(req.params.id));
  if (!u) return erro(req, res, 404, 'Acesso não encontrado.');
  const senha = senhaTemporaria();
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 1 WHERE id = ?').run(hashSenha(senha), u.id);
  telaCredenciais(req, res, u, senha);
});
app.post('/proprietarios/:id/ativo', exigirLogin, exigirAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id !== req.usuario.id) db.prepare('UPDATE usuarios SET ativo = 1 - ativo WHERE id = ?').run(id);
  res.redirect('/proprietarios');
});

// ---------- Unidades ----------
const PARCELAS_PADRAO = 'Entrada; 0; 3000\n1ª parcela; 30; 3000\n2ª parcela; 60; 3000\n3ª parcela; 90; 2500';

function formUnidade(u, props, nova) {
  return `
  <label>Unidade<input name="numero" value="${esc(u.numero || '')}" required></label>
  <label>Edifício<input name="edificio" value="${esc(u.edificio || 'Edifício Athenas')}"></label>
  <label>Proprietário<select name="proprietario_id"><option value="">—</option>${props.map(p => `<option value="${p.id}"${p.id === u.proprietario_id ? ' selected' : ''}>${esc(p.nome)}</option>`).join('')}</select></label>
  <label>Área privativa<input name="area" value="${esc(u.area || '')}" placeholder="39,88 m²"></label>
  <label>Assinatura do contrato<input name="data_assinatura" type="date" value="${esc(u.data_assinatura || '')}"></label>
  <label>Prazo de implantação (dias corridos, conforme contrato)<input name="prazo_dias" type="number" min="1" required value="${esc(u.prazo_dias || '')}"></label>
  <label>Verba de compras estimada (R$)<input name="verba_estimada" value="${u.verba_estimada ? esc(String(u.verba_estimada).replace('.', ',')) : ''}" placeholder="21.243,06"></label>
  <label>Status da unidade<select name="status">${options(['Em montagem', 'Entregue ao proprietário', 'Pausada'], u.status || 'Em montagem')}</select></label>
  <label class="largo">Endereço de entrega das compras<input name="endereco_entrega" value="${esc(u.endereco_entrega || '')}" placeholder="Via Othon de Carvalho, 96, apto 802 – São Lourenço/MG – CEP 37470-000"></label>
  ${nova ? `<label class="largo">Parcelas do Pacote Stay22 (uma por linha: descrição; dias após a assinatura; valor)<textarea name="parcelas" rows="4">${PARCELAS_PADRAO}</textarea></label>
  <label class="check"><input type="checkbox" name="itens_padrao" checked> Criar os itens do Anexo I (38 itens)</label>
  <label class="check"><input type="checkbox" name="etapas_padrao" checked> Criar o cronograma padrão</label>` : ''}
  <label class="largo">Observações internas (só a equipe vê)<textarea name="obs_interna" rows="2">${esc(u.obs_interna || '')}</textarea></label>`;
}
function lerUnidade(b) {
  return {
    numero: String(b.numero || '').trim(), edificio: String(b.edificio || 'Edifício Athenas').trim(),
    proprietario_id: b.proprietario_id ? Number(b.proprietario_id) : null, area: b.area || null,
    data_assinatura: U.lerData(b.data_assinatura), prazo_dias: Number(b.prazo_dias) || 90,
    verba_estimada: U.lerMoeda(b.verba_estimada) || 0, status: b.status || 'Em montagem',
    endereco_entrega: b.endereco_entrega || null, obs_interna: b.obs_interna || null,
  };
}
const proprietarios = () => db.prepare("SELECT id, nome FROM usuarios WHERE papel = 'proprietario' AND ativo = 1 ORDER BY nome").all();

app.get('/unidades/nova', exigirLogin, exigirAdmin, (req, res) => {
  pagina(req, res, 'Nova unidade', `
  <section class="cabecalho"><div><h1>Nova unidade</h1><p class="sub">Cadastre o proprietário antes em <a href="/proprietarios">Proprietários</a>.</p></div></section>
  <section class="cartao"><form method="post" action="/unidades" class="form grade2">${formUnidade({}, proprietarios(), true)}<button>Criar unidade</button></form></section>`);
});
app.post('/unidades', exigirLogin, exigirAdmin, (req, res) => {
  const d = lerUnidade(req.body);
  if (!d.numero) return erro(req, res, 400, 'Informe o número da unidade.');
  const parcelas = String(req.body.parcelas || '').split('\n').map(l => l.split(';').map(s => s.trim())).filter(p => p[0] && p[2]);
  const pacote = parcelas.reduce((a, p) => a + (U.lerMoeda(p[2]) || 0), 0);
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO unidades (numero, edificio, proprietario_id, area, data_assinatura, prazo_dias, verba_estimada, pacote_valor, status, endereco_entrega, obs_interna, criado_em)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.numero, d.edificio, d.proprietario_id, d.area, d.data_assinatura, d.prazo_dias, d.verba_estimada, pacote, d.status, d.endereco_entrega, d.obs_interna, U.agora());
    const uid = Number(r.lastInsertRowid);
    parcelas.forEach((p, i) => db.prepare('INSERT INTO parcelas (unidade_id, ordem, descricao, vencimento, valor) VALUES (?,?,?,?,?)')
      .run(uid, i, p[0], d.data_assinatura && p[1] !== '' ? U.addDias(d.data_assinatura, Number(p[1]) || 0) : null, U.lerMoeda(p[2]) || 0));
    if (req.body.itens_padrao) ITENS_PADRAO.forEach((x, i) => db.prepare('INSERT INTO itens (unidade_id, ordem, categoria, nome, qtd, instalacao, atualizado_em) VALUES (?,?,?,?,?,?,?)').run(uid, i, x[0], x[1], x[2], x[3], U.agora()));
    if (req.body.etapas_padrao) ETAPAS_PADRAO.forEach((x, i) => {
      const prazo = !d.data_assinatura || x[2] === null ? null : x[2] === 'P' ? U.addDias(d.data_assinatura, d.prazo_dias) : U.addDias(d.data_assinatura, x[2]);
      db.prepare('INSERT INTO etapas (unidade_id, ordem, nome, responsavel, prazo) VALUES (?,?,?,?,?)').run(uid, i, x[0], x[1], prazo);
    });
    registrar(uid, null, req.usuario.id, 'Unidade criada', `Unidade ${d.numero}`);
    db.exec('COMMIT');
    res.redirect('/u/' + uid + '?msg=criada');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

app.post('/u/:id/config', exigirLogin, exigirAdmin, (req, res) => {
  const u = unidadeComAcesso(req, req.params.id);
  if (!u) return erro(req, res, 404, 'Unidade não encontrada.');
  const d = lerUnidade(req.body);
  db.prepare(`UPDATE unidades SET numero=?, edificio=?, proprietario_id=?, area=?, data_assinatura=?, prazo_dias=?, verba_estimada=?, status=?, endereco_entrega=?, obs_interna=? WHERE id=?`)
    .run(d.numero || u.numero, d.edificio, d.proprietario_id, d.area, d.data_assinatura, d.prazo_dias, d.verba_estimada, d.status, d.endereco_entrega, d.obs_interna, u.id);
  const mud = [];
  if (u.prazo_dias !== d.prazo_dias) mud.push(`prazo ${u.prazo_dias} → ${d.prazo_dias} dias`);
  if (u.data_assinatura !== d.data_assinatura) mud.push(`assinatura ${data(u.data_assinatura)} → ${data(d.data_assinatura)}`);
  if (u.verba_estimada !== d.verba_estimada) mud.push(`verba ${moeda(u.verba_estimada)} → ${moeda(d.verba_estimada)}`);
  registrar(u.id, null, req.usuario.id, 'Dados da unidade alterados', mud.join('; ') || null);
  res.redirect('/u/' + u.id + '?msg=salvo#config');
});

app.get('/u/:id', exigirLogin, (req, res) => {
  const u = unidadeComAcesso(req, req.params.id);
  if (!u) return erro(req, res, 404, 'Unidade não encontrada.');
  const admin = ehAdmin(req);
  const r = resumo(u);
  const prop = u.proprietario_id ? db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.proprietario_id) : null;
  const filtro = STATUS_ITEM.includes(req.query.status) ? req.query.status : null;
  const etapas = db.prepare('SELECT * FROM etapas WHERE unidade_id = ? ORDER BY ordem, id').all(u.id);
  const anexos = db.prepare('SELECT a.*, i.nome AS item_nome FROM anexos a LEFT JOIN itens i ON i.id = a.item_id WHERE a.unidade_id = ? ORDER BY a.id DESC').all(u.id);
  const hist = db.prepare('SELECT h.*, us.nome AS quem, i.nome AS item_nome FROM historico h LEFT JOIN usuarios us ON us.id = h.usuario_id LEFT JOIN itens i ON i.id = h.item_id WHERE h.unidade_id = ? ORDER BY h.id DESC LIMIT 60').all(u.id);
  const hoje = U.hoje();

  const kpis = `
  <section class="kpis">
    <div><span>Verba estimada</span><strong>${moeda(u.verba_estimada)}</strong></div>
    <div><span>Já comprado</span><strong>${moeda(r.pago)}</strong></div>
    <div><span>Saldo da verba</span><strong>${moeda(r.saldo)}</strong></div>
    <div><span>Itens comprados</span><strong>${r.comprados}/${r.total}</strong><div class="barra"><span style="width:${r.progresso}%"></span></div></div>
    <div><span>Entrega prevista</span><strong>${r.entrega ? data(r.entrega) : '—'}</strong><em>${r.diasRestantes === null ? '' : r.diasRestantes >= 0 ? `faltam ${r.diasRestantes} dias` : `${Math.abs(r.diasRestantes)} dias de atraso`}</em></div>
  </section>`;

  const alertas = [];
  if (admin) {
    r.aprovacaoVencida.forEach(i => alertas.push(`<a href="/itens/${i.id}">${esc(i.nome)}</a>: link enviado em ${data(i.link_enviado_em)}, prazo de aprovação venceu em ${data(prazoAprovacao(i))}`));
    r.revisar.forEach(i => alertas.push(`<a href="/itens/${i.id}">${esc(i.nome)}</a>: proprietário pediu outra opção`));
  }
  r.ofertasVencendo.forEach(i => alertas.push(`<a href="/itens/${i.id}">${esc(i.nome)}</a>: preço da oferta vale até ${data(i.oferta_ate)}`));
  r.atrasadas.forEach(i => alertas.push(`<a href="/itens/${i.id}">${esc(i.nome)}</a>: entrega prevista para ${data(i.previsao_entrega)} ainda não chegou`));
  r.parcelasVencidas.forEach(p => alertas.push(`Parcela "${esc(p.descricao)}" do Pacote Stay22 venceu em ${data(p.vencimento)}`));
  if (r.pago > r.teto) alertas.push('Compras passaram de 30% acima da verba estimada (cl. 5.2): precisa de aprovação por escrito.');

  const aguardando = r.aguardando.length ? `
  <section class="cartao destaque">
    <h2>${admin ? 'Aguardando compra do proprietário' : 'Aguardando a sua compra'} <span class="contador">${r.aguardando.length}</span></h2>
    <div class="cards">${r.aguardando.map(i => `
      <a class="card-item" href="/itens/${i.id}">
        <span class="mini">${esc(i.categoria)}</span>
        <strong>${esc(i.nome)}</strong>
        <span>${esc(i.loja || '')} · ${moeda(i.valor_orcado)}</span>
        ${i.oferta_ate ? `<span class="mini oferta">Oferta até ${data(i.oferta_ate)}</span>` : ''}
        <span class="mini">Enviado em ${data(i.link_enviado_em)}</span>
      </a>`).join('')}</div>
  </section>` : '';

  const visiveis = filtro ? r.itens.filter(i => i.status === filtro) : r.itens;
  const cats = [...new Set(visiveis.map(i => i.categoria))];
  const contagem = s => r.itens.filter(i => i.status === s).length;
  const chips = `<div class="chips"><a href="/u/${u.id}#itens" class="${filtro ? '' : 'ativo'}">Todos (${r.itens.length})</a>${STATUS_ITEM.filter(s => contagem(s)).map(s => `<a href="/u/${u.id}?status=${encodeURIComponent(s)}#itens" class="${filtro === s ? 'ativo' : ''}">${esc(s)} (${contagem(s)})</a>`).join('')}</div>`;
  const listaItens = cats.map(c => `
    <h3>${esc(c)}</h3>
    <div class="itens">${visiveis.filter(i => i.categoria === c).map(i => `
      <a class="item ${i.status === 'Cancelado' ? 'cancelado' : ''}" href="/itens/${i.id}">
        <span class="nome">${esc(i.nome)}${i.qtd && i.qtd !== '1' ? ` <em>× ${esc(i.qtd)}</em>` : ''}</span>
        <span class="st">${pill(i.status)}</span>
        <span class="val"><small>Orçado</small>${moeda(i.valor_orcado)}</span>
        <span class="val"><small>Pago</small>${moeda(i.valor_pago)}</span>
        <span class="ent"><small>Entrega</small>${i.entregue_em ? 'Entregue ' + data(i.entregue_em) : i.previsao_entrega ? 'Prevista ' + data(i.previsao_entrega) : '—'}</span>
        <span class="ins"><small>Instalação</small>${pill(i.instalacao)}</span>
      </a>`).join('')}</div>`).join('');

  const parcelas = `
  <section class="cartao">
    <h2>Pacote Stay22 <span class="mini">${moeda(r.pacoteRecebido)} pagos de ${moeda(r.pacoteTotal)}</span></h2>
    <div class="tabela-rolagem"><table class="tabela"><thead><tr><th>Parcela</th><th>Vencimento</th><th>Valor</th><th>Situação</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>
    ${r.parcelas.map(p => {
      const sit = p.pago_em ? `<span class="pill verde">Paga em ${data(p.pago_em)}</span>` : p.vencimento && p.vencimento < hoje ? '<span class="pill vermelho">Vencida</span>' : '<span class="pill cinza">Em aberto</span>';
      return admin ? `<tr><td>${esc(p.descricao)}</td><td colspan="4">
        <form method="post" action="/parcelas/${p.id}" class="inline">
          <input type="date" name="vencimento" value="${esc(p.vencimento || '')}" aria-label="Vencimento">
          <input name="valor" value="${esc(String(p.valor).replace('.', ','))}" aria-label="Valor" class="curto">
          <label class="mini">Paga em <input type="date" name="pago_em" value="${esc(p.pago_em || '')}"></label>
          ${sit}<button class="pequeno">Salvar</button></form></td></tr>`
        : `<tr><td>${esc(p.descricao)}</td><td>${data(p.vencimento)}</td><td class="num">${moeda(p.valor)}</td><td>${sit}</td></tr>`;
    }).join('')}
    </tbody></table></div>
  </section>`;

  const cronograma = `
  <section class="cartao" id="cronograma">
    <h2>Cronograma</h2>
    <div class="etapas">${etapas.map(e => admin ? `
      <form method="post" action="/etapas/${e.id}" class="etapa">
        <div class="etapa-nome"><strong>${esc(e.nome)}</strong><span class="mini">${esc(e.responsavel || '')}</span></div>
        <label class="mini">Prazo<input type="date" name="prazo" value="${esc(e.prazo || '')}"></label>
        <label class="mini">Status<select name="status">${options(STATUS_ETAPA, e.status)}</select></label>
        <label class="mini">Concluída em<input type="date" name="concluida_em" value="${esc(e.concluida_em || '')}"></label>
        <label class="mini obs">Observação<input name="obs" value="${esc(e.obs || '')}"></label>
        <button class="pequeno">Salvar</button>
      </form>` : `
      <div class="etapa leitura ${e.prazo && e.prazo < hoje && e.status !== 'Concluída' ? 'atrasada' : ''}">
        <div class="etapa-nome"><strong>${esc(e.nome)}</strong><span class="mini">${esc(e.responsavel || '')}${e.obs ? ' · ' + esc(e.obs) : ''}</span></div>
        <span class="mini">${e.status === 'Concluída' ? 'Concluída em ' + data(e.concluida_em) : e.prazo ? 'Prazo ' + data(e.prazo) : ''}</span>
        ${pill(e.status)}
      </div>`).join('')}</div>
    ${admin ? `<form method="post" action="/u/${u.id}/etapas" class="inline novo"><input name="nome" placeholder="Nova etapa" required><input name="responsavel" placeholder="Responsável"><input type="date" name="prazo"><button class="pequeno">Adicionar etapa</button></form>` : ''}
  </section>`;

  const docs = `
  <section class="cartao" id="documentos">
    <h2>Notas fiscais e comprovantes <span class="mini">${anexos.length} arquivo(s)</span></h2>
    ${anexos.length ? `<ul class="anexos">${anexos.map(a => `<li><a href="/anexos/${a.id}" target="_blank" rel="noopener">${esc(a.tipo)}${a.item_nome ? ' · ' + esc(a.item_nome) : ''}</a> <span class="mini">${esc(a.nome_original || '')} · ${U.dataHora(a.criado_em)}</span></li>`).join('')}</ul>` : '<p class="mini">Nenhum arquivo ainda. Os anexos de cada item aparecem aqui.</p>'}
    ${admin ? `<p><a href="/u/${u.id}/exportar.csv">Baixar planilha completa da unidade (CSV)</a></p>` : ''}
  </section>`;

  const historico = `
  <section class="cartao" id="historico">
    <h2>Histórico</h2>
    <ul class="historico">${hist.map(h => `<li><span class="mini">${U.dataHora(h.criado_em)} · ${esc(h.quem || 'Sistema')}</span><div>${esc(h.acao)}${h.item_nome ? ` · <a href="/itens/${h.item_id}">${esc(h.item_nome)}</a>` : ''}${h.detalhes ? `<span class="mini"> — ${esc(h.detalhes)}</span>` : ''}</div></li>`).join('') || '<li class="mini">Sem registros.</li>'}</ul>
  </section>`;

  const adminExtra = admin ? `
  <section class="cartao" id="novo-item">
    <h2>Adicionar item</h2>
    <form method="post" action="/u/${u.id}/itens" class="form grade3">
      <label>Categoria<input name="categoria" list="cats" required></label>
      <label>Item<input name="nome" required></label>
      <label>Quantidade<input name="qtd" value="1"></label>
      <label>Montagem / instalação<select name="instalacao">${options(STATUS_INSTALACAO, 'Não precisa')}</select></label>
      <datalist id="cats">${[...new Set(r.itens.map(i => i.categoria))].map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <button>Adicionar</button>
    </form>
  </section>
  <section class="cartao" id="config">
    <h2>Dados da unidade</h2>
    <form method="post" action="/u/${u.id}/config" class="form grade2">${formUnidade(u, proprietarios(), false)}<button>Salvar dados</button></form>
  </section>` : '';

  pagina(req, res, `Unidade ${u.numero}`, `
  <section class="cabecalho">
    <div><p class="sobre">${esc(u.edificio)}</p><h1>Unidade ${esc(u.numero)}</h1>
    <p class="sub">${prop ? esc(prop.nome) : 'Sem proprietário vinculado'}${u.area ? ' · ' + esc(u.area) : ''}${u.data_assinatura ? ' · contrato assinado em ' + data(u.data_assinatura) : ''} · prazo de ${u.prazo_dias} dias</p></div>
    <div>${pill(u.status)}</div>
  </section>
  ${kpis}
  ${alertas.length ? `<section class="cartao alerta"><h2>Atenção</h2><ul class="lista-alertas">${alertas.map(a => `<li>${a}</li>`).join('')}</ul></section>` : ''}
  ${aguardando}
  <section class="cartao" id="itens">
    <h2>Itens da montagem</h2>
    ${chips}
    ${listaItens || '<p class="mini">Nenhum item com esse status.</p>'}
  </section>
  ${parcelas}
  ${cronograma}
  ${docs}
  ${adminExtra}
  ${historico}`);
});

app.post('/u/:id/itens', exigirLogin, exigirAdmin, (req, res) => {
  const u = unidadeComAcesso(req, req.params.id);
  if (!u) return erro(req, res, 404, 'Unidade não encontrada.');
  const { categoria, nome, qtd, instalacao } = req.body;
  if (!categoria || !nome) return erro(req, res, 400, 'Informe categoria e item.');
  const ordem = db.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 o FROM itens WHERE unidade_id = ?').get(u.id).o;
  const r = db.prepare('INSERT INTO itens (unidade_id, ordem, categoria, nome, qtd, instalacao, atualizado_em) VALUES (?,?,?,?,?,?,?)')
    .run(u.id, ordem, categoria.trim(), nome.trim(), qtd || null, STATUS_INSTALACAO.includes(instalacao) ? instalacao : 'Não precisa', U.agora());
  registrar(u.id, Number(r.lastInsertRowid), req.usuario.id, 'Item adicionado', nome.trim());
  res.redirect('/itens/' + r.lastInsertRowid + '?msg=item');
});

app.post('/u/:id/etapas', exigirLogin, exigirAdmin, (req, res) => {
  const u = unidadeComAcesso(req, req.params.id);
  if (!u) return erro(req, res, 404, 'Unidade não encontrada.');
  const ordem = db.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 o FROM etapas WHERE unidade_id = ?').get(u.id).o;
  db.prepare('INSERT INTO etapas (unidade_id, ordem, nome, responsavel, prazo) VALUES (?,?,?,?,?)').run(u.id, ordem, req.body.nome, req.body.responsavel || null, U.lerData(req.body.prazo));
  registrar(u.id, null, req.usuario.id, 'Etapa adicionada', req.body.nome);
  res.redirect('/u/' + u.id + '?msg=salvo#cronograma');
});

app.post('/etapas/:id', exigirLogin, exigirAdmin, (req, res) => {
  const e = db.prepare('SELECT * FROM etapas WHERE id = ?').get(Number(req.params.id));
  if (!e) return erro(req, res, 404, 'Etapa não encontrada.');
  const status = STATUS_ETAPA.includes(req.body.status) ? req.body.status : e.status;
  let concl = U.lerData(req.body.concluida_em);
  if (status === 'Concluída' && !concl) concl = U.hoje();
  db.prepare('UPDATE etapas SET prazo = ?, status = ?, concluida_em = ?, obs = ? WHERE id = ?').run(U.lerData(req.body.prazo), status, concl, req.body.obs || null, e.id);
  if (status !== e.status) registrar(e.unidade_id, null, req.usuario.id, 'Etapa: ' + e.nome, `${e.status} → ${status}`);
  res.redirect('/u/' + e.unidade_id + '?msg=salvo#cronograma');
});

app.post('/parcelas/:id', exigirLogin, exigirAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM parcelas WHERE id = ?').get(Number(req.params.id));
  if (!p) return erro(req, res, 404, 'Parcela não encontrada.');
  const pago = U.lerData(req.body.pago_em);
  const valor = U.lerMoeda(req.body.valor) ?? p.valor;
  db.prepare('UPDATE parcelas SET vencimento = ?, valor = ?, pago_em = ? WHERE id = ?').run(U.lerData(req.body.vencimento), valor, pago, p.id);
  db.prepare('UPDATE unidades SET pacote_valor = (SELECT SUM(valor) FROM parcelas WHERE unidade_id = ?) WHERE id = ?').run(p.unidade_id, p.unidade_id);
  if (pago !== p.pago_em) registrar(p.unidade_id, null, req.usuario.id, 'Pacote Stay22: ' + p.descricao, pago ? `paga em ${data(pago)} (${moeda(valor)})` : 'pagamento desmarcado');
  res.redirect('/u/' + p.unidade_id + '?msg=salvo');
});

// ---------- Item ----------
const CAMPOS_ITEM = {
  categoria: 'Categoria', nome: 'Item', qtd: 'Quantidade', status: 'Status', valor_orcado: 'Valor orçado', valor_pago: 'Valor pago',
  loja: 'Loja', link: 'Link', oferta_ate: 'Oferta até', forma_pagamento: 'Forma de pagamento', parcelas_cartao: 'Parcelas no cartão',
  numero_pedido: 'Nº do pedido', link_enviado_em: 'Link enviado em', comprado_em: 'Comprado em', previsao_entrega: 'Previsão de entrega',
  entregue_em: 'Entregue em', instalacao: 'Instalação', instalador: 'Quem instala', instalacao_data: 'Data da instalação',
  nf_ok: 'NF em nome do proprietário', obs_interna: 'Observação interna',
};
const fmtCampo = (k, v) => v === null || v === undefined || v === '' ? '—'
  : ['valor_orcado', 'valor_pago'].includes(k) ? moeda(v)
  : ['oferta_ate', 'link_enviado_em', 'comprado_em', 'previsao_entrega', 'entregue_em', 'instalacao_data'].includes(k) ? data(v)
  : k === 'nf_ok' ? (v ? 'sim' : 'não') : String(v);

function mudancas(antes, depois, ignorar = []) {
  return Object.keys(depois).filter(k => !ignorar.includes(k) && String(antes[k] ?? '') !== String(depois[k] ?? ''))
    .map(k => `${CAMPOS_ITEM[k] || k}: ${fmtCampo(k, antes[k])} → ${fmtCampo(k, depois[k])}`);
}
function salvarItem(it, novo) {
  const ks = Object.keys(novo);
  db.prepare(`UPDATE itens SET ${ks.map(k => k + ' = ?').join(', ')}, atualizado_em = ? WHERE id = ?`).run(...ks.map(k => novo[k]), U.agora(), it.id);
}

const subir = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'anexos'),
    filename: (req, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6)),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, f, cb) => cb(null, /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/.test(f.mimetype)),
});
function descartar(req) { if (req.file) fs.unlink(req.file.path, () => {}); }
function guardarAnexo(req, u, it, tipo) {
  if (!req.file) return false;
  db.prepare('INSERT INTO anexos (unidade_id, item_id, tipo, arquivo, nome_original, mime, enviado_por, criado_em) VALUES (?,?,?,?,?,?,?,?)')
    .run(u.id, it ? it.id : null, TIPOS_ANEXO.includes(tipo) ? tipo : 'Outro', req.file.filename, String(req.file.originalname || '').slice(0, 120), req.file.mimetype, req.usuario.id, U.agora());
  registrar(u.id, it ? it.id : null, req.usuario.id, 'Arquivo anexado', `${tipo}: ${req.file.originalname}`);
  return true;
}

function mensagemWhatsApp(req, it, u, prop) {
  const linhas = [
    `Olá, ${primeiroNome(prop && prop.nome)}! Tudo bem?`, '',
    `Separei mais um item para a montagem da unidade ${u.numero}:`, '',
    `*${it.nome}*${it.qtd && it.qtd !== '1' ? ` (${it.qtd})` : ''}`,
  ];
  if (it.loja) linhas.push(`Loja: ${it.loja}`);
  if (it.valor_orcado) linhas.push(`Valor: ${moeda(it.valor_orcado)}`);
  if (it.oferta_ate) linhas.push(`Preço promocional válido até ${data(it.oferta_ate)}`);
  linhas.push('', 'Para ver os detalhes, comprar e registrar a compra, acesse o painel:', `${baseUrl(req)}/itens/${it.id}`, '',
    'Lembrando: entrega no endereço da unidade e nota fiscal no seu nome e CPF.', '', 'Qualquer dúvida, estou à disposição.', 'Stay22');
  return linhas.join('\n');
}

app.get('/itens/:id', exigirLogin, (req, res) => {
  const x = itemComAcesso(req, req.params.id);
  if (!x) return erro(req, res, 404, 'Item não encontrado.');
  const { it, u } = x;
  const admin = ehAdmin(req);
  const prop = u.proprietario_id ? db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.proprietario_id) : null;
  const anexos = db.prepare('SELECT * FROM anexos WHERE item_id = ? ORDER BY id DESC').all(it.id);
  const hist = db.prepare('SELECT h.*, us.nome AS quem FROM historico h LEFT JOIN usuarios us ON us.id = h.usuario_id WHERE h.item_id = ? ORDER BY h.id DESC').all(it.id);
  const pa = prazoAprovacao(it);
  const endereco = u.endereco_entrega || `Edifício Athenas – unidade ${u.numero}, São Lourenço/MG`;
  const linkLoja = it.link && /^https?:\/\//i.test(it.link) ? it.link : null;

  const detalhes = `
  <dl class="dados">
    <dt>Status</dt><dd>${pill(it.status)}</dd>
    <dt>Quantidade</dt><dd>${esc(it.qtd || '—')}</dd>
    <dt>Loja</dt><dd>${esc(it.loja || '—')}</dd>
    <dt>Valor orçado</dt><dd>${moeda(it.valor_orcado)}</dd>
    ${it.oferta_ate ? `<dt>Oferta válida até</dt><dd class="oferta">${data(it.oferta_ate)}</dd>` : ''}
    ${it.link_enviado_em ? `<dt>Enviado em</dt><dd>${data(it.link_enviado_em)}${it.status === 'Link enviado' ? ` · aprovar até ${data(pa)}` : ''}</dd>` : ''}
    ${it.valor_pago ? `<dt>Valor pago</dt><dd>${moeda(it.valor_pago)}${it.forma_pagamento ? ' · ' + esc(it.forma_pagamento) : ''}${it.parcelas_cartao ? ` em ${it.parcelas_cartao}x` : ''}</dd>` : ''}
    ${it.numero_pedido ? `<dt>Nº do pedido</dt><dd>${esc(it.numero_pedido)}</dd>` : ''}
    ${it.comprado_em ? `<dt>Comprado em</dt><dd>${data(it.comprado_em)}</dd>` : ''}
    <dt>Entrega</dt><dd>${it.entregue_em ? 'Entregue em ' + data(it.entregue_em) : it.previsao_entrega ? 'Prevista para ' + data(it.previsao_entrega) : '—'}</dd>
    <dt>Montagem / instalação</dt><dd>${pill(it.instalacao)}${it.instalacao_data ? ' ' + data(it.instalacao_data) : ''}${it.instalador ? ' · ' + esc(it.instalador) : ''}</dd>
    ${it.msg_proprietario ? `<dt>Mensagem do proprietário</dt><dd>${esc(it.msg_proprietario)}</dd>` : ''}
  </dl>`;

  const podeComprar = ['Link enviado', 'Orçado', 'Revisar'].includes(it.status) && (admin || it.status !== 'Orçado');
  const compra = podeComprar ? `
  <section class="cartao destaque">
    <h2>${admin ? 'Registrar compra (pelo proprietário)' : 'Comprar este item'}</h2>
    ${linkLoja ? `<a class="botao grande" href="${esc(linkLoja)}" target="_blank" rel="noopener noreferrer">Abrir na loja${it.loja ? ' · ' + esc(it.loja) : ''}</a>` : '<p class="mini">O link da loja ainda não foi cadastrado.</p>'}
    <div class="instrucoes">
      <strong>Na hora da compra</strong>
      <ul><li>Endereço de entrega: ${esc(endereco)}</li><li>Nota fiscal no nome e CPF do proprietário</li><li>Depois de pagar, registre a compra aqui embaixo e anexe o comprovante</li></ul>
    </div>
    <form method="post" action="/itens/${it.id}/comprei" enctype="multipart/form-data" class="form grade2">
      <label>Valor pago (R$)<input name="valor_pago" inputmode="decimal" required placeholder="${it.valor_orcado ? esc(String(it.valor_orcado).replace('.', ',')) : '0,00'}"></label>
      <label>Forma de pagamento<select name="forma_pagamento" required><option value="">Selecione</option>${options(FORMAS_PAGAMENTO, null)}</select></label>
      <label>Parcelas (se cartão)<input name="parcelas_cartao" type="number" min="1" max="24"></label>
      <label>Nº do pedido<input name="numero_pedido"></label>
      <label>Previsão de entrega<input name="previsao_entrega" type="date"></label>
      <label>Comprovante ou nota fiscal (PDF ou foto)<input type="file" name="arquivo" accept="application/pdf,image/*"></label>
      <button>Registrar compra</button>
    </form>
    ${!admin ? `
    <details class="revisar"><summary>Prefiro outra opção para este item</summary>
      <form method="post" action="/itens/${it.id}/revisar" class="form">
        <label>Conte o que prefere (outro modelo, outra cor, outro valor…)<textarea name="msg" rows="3" required></textarea></label>
        <button class="claro">Enviar para a Stay22</button>
      </form>
    </details>` : ''}
  </section>` : '';

  const posCompra = !admin && ['Comprado', 'Entregue'].includes(it.status) ? `
  <section class="cartao">
    <h2>Atualizar a compra</h2>
    <form method="post" action="/itens/${it.id}/acompanhar" enctype="multipart/form-data" class="form grade2">
      <label>Previsão de entrega<input name="previsao_entrega" type="date" value="${esc(it.previsao_entrega || '')}"></label>
      <label>Tipo do arquivo<select name="tipo">${options(TIPOS_ANEXO, 'Nota fiscal')}</select></label>
      <label class="largo">Anexar nota fiscal ou comprovante<input type="file" name="arquivo" accept="application/pdf,image/*"></label>
      <button>Salvar</button>
    </form>
  </section>` : '';

  const wa = prop ? `https://wa.me/${U.waNumero(prop.whatsapp)}?text=${encodeURIComponent(mensagemWhatsApp(req, it, u, prop))}` : null;
  const edicao = admin ? `
  <section class="cartao destaque">
    <h2>Enviar ao proprietário</h2>
    ${!it.link || !it.valor_orcado ? '<p class="mini">Cadastre o link e o valor orçado abaixo antes de enviar.</p>' : ''}
    ${wa ? `<form method="post" action="/itens/${it.id}/enviar" target="_blank" class="inline"><button class="whatsapp" ${!it.link || !it.valor_orcado ? 'disabled' : ''}>${it.link_enviado_em ? 'Reenviar' : 'Enviar'} pelo WhatsApp para ${esc(primeiroNome(prop.nome))}</button></form>
    <p class="mini">Abre o WhatsApp com a mensagem pronta, marca o item como "Link enviado" e começa a contar os 3 dias úteis para a aprovação.</p>` : '<p class="mini">Vincule um proprietário à unidade para enviar.</p>'}
  </section>
  <section class="cartao">
    <h2>Editar item</h2>
    <form method="post" action="/itens/${it.id}" class="form grade3">
      <label>Categoria<input name="categoria" value="${esc(it.categoria)}" required></label>
      <label>Item<input name="nome" value="${esc(it.nome)}" required></label>
      <label>Quantidade<input name="qtd" value="${esc(it.qtd || '')}"></label>
      <label>Status<select name="status">${options(STATUS_ITEM, it.status)}</select></label>
      <label>Loja<input name="loja" value="${esc(it.loja || '')}"></label>
      <label>Valor orçado (R$)<input name="valor_orcado" value="${it.valor_orcado ? esc(String(it.valor_orcado).replace('.', ',')) : ''}"></label>
      <label class="largo">Link de compra<input name="link" type="url" value="${esc(it.link || '')}" placeholder="https://"></label>
      <label>Oferta válida até<input name="oferta_ate" type="date" value="${esc(it.oferta_ate || '')}"></label>
      <label>Link enviado em<input name="link_enviado_em" type="date" value="${esc(U.diaDe(it.link_enviado_em) || '')}"></label>
      <label>Comprado em<input name="comprado_em" type="date" value="${esc(it.comprado_em || '')}"></label>
      <label>Valor pago (R$)<input name="valor_pago" value="${it.valor_pago ? esc(String(it.valor_pago).replace('.', ',')) : ''}"></label>
      <label>Forma de pagamento<select name="forma_pagamento"><option value="">—</option>${options(FORMAS_PAGAMENTO, it.forma_pagamento)}</select></label>
      <label>Parcelas no cartão<input name="parcelas_cartao" type="number" min="1" max="24" value="${esc(it.parcelas_cartao || '')}"></label>
      <label>Nº do pedido<input name="numero_pedido" value="${esc(it.numero_pedido || '')}"></label>
      <label>Previsão de entrega<input name="previsao_entrega" type="date" value="${esc(it.previsao_entrega || '')}"></label>
      <label>Entregue em<input name="entregue_em" type="date" value="${esc(it.entregue_em || '')}"></label>
      <label>Montagem / instalação<select name="instalacao">${options(STATUS_INSTALACAO, it.instalacao)}</select></label>
      <label>Quem instala<input name="instalador" value="${esc(it.instalador || '')}"></label>
      <label>Data da instalação<input name="instalacao_data" type="date" value="${esc(it.instalacao_data || '')}"></label>
      <label class="check"><input type="checkbox" name="nf_ok" ${it.nf_ok ? 'checked' : ''}> NF em nome do proprietário conferida</label>
      <label class="largo">Observação interna (o proprietário não vê)<textarea name="obs_interna" rows="2">${esc(it.obs_interna || '')}</textarea></label>
      <button>Salvar item</button>
    </form>
    <details class="perigo"><summary>Excluir item</summary>
      <form method="post" action="/itens/${it.id}/excluir" class="inline"><label class="check"><input type="checkbox" name="confirmo" required> Confirmo a exclusão de "${esc(it.nome)}"</label><button class="vermelho pequeno">Excluir</button></form>
    </details>
  </section>` : '';

  const anexosHtml = `
  <section class="cartao">
    <h2>Arquivos do item</h2>
    ${anexos.length ? `<ul class="anexos">${anexos.map(a => `<li><a href="/anexos/${a.id}" target="_blank" rel="noopener">${esc(a.tipo)}</a> <span class="mini">${esc(a.nome_original || '')} · ${U.dataHora(a.criado_em)}</span></li>`).join('')}</ul>` : '<p class="mini">Nenhum arquivo.</p>'}
    ${admin ? `<form method="post" action="/itens/${it.id}/anexos" enctype="multipart/form-data" class="inline"><select name="tipo">${options(TIPOS_ANEXO, 'Nota fiscal')}</select><input type="file" name="arquivo" accept="application/pdf,image/*" required><button class="pequeno">Anexar</button></form>` : ''}
  </section>`;

  const histHtml = `
  <section class="cartao">
    <h2>Histórico do item</h2>
    <ul class="historico">${hist.map(h => `<li><span class="mini">${U.dataHora(h.criado_em)} · ${esc(h.quem || 'Sistema')}</span><div>${esc(h.acao)}${h.detalhes ? `<span class="mini"> — ${esc(h.detalhes)}</span>` : ''}</div></li>`).join('') || '<li class="mini">Sem registros.</li>'}</ul>
  </section>`;

  pagina(req, res, it.nome, `
  <p class="trilha"><a href="/u/${u.id}">← Unidade ${esc(u.numero)}</a></p>
  <section class="cabecalho"><div><p class="sobre">${esc(it.categoria)}</p><h1>${esc(it.nome)}</h1></div></section>
  <div class="duas-colunas">
    <div>${compra}${edicao}${posCompra}</div>
    <div><section class="cartao">${detalhes}</section>${anexosHtml}${histHtml}</div>
  </div>`);
});

app.post('/itens/:id', exigirLogin, exigirAdmin, (req, res) => {
  const x = itemComAcesso(req, req.params.id);
  if (!x) return erro(req, res, 404, 'Item não encontrado.');
  const { it, u } = x;
  const b = req.body;
  const enviadoDia = U.lerData(b.link_enviado_em);
  const novo = {
    categoria: (b.categoria || it.categoria).trim(), nome: (b.nome || it.nome).trim(), qtd: b.qtd || null,
    status: STATUS_ITEM.includes(b.status) ? b.status : it.status,
    loja: b.loja || null, valor_orcado: U.lerMoeda(b.valor_orcado), link: b.link || null, oferta_ate: U.lerData(b.oferta_ate),
    link_enviado_em: enviadoDia ? (U.diaDe(it.link_enviado_em) === enviadoDia ? it.link_enviado_em : enviadoDia + 'T15:00:00.000Z') : null,
    comprado_em: U.lerData(b.comprado_em), valor_pago: U.lerMoeda(b.valor_pago),
    forma_pagamento: FORMAS_PAGAMENTO.includes(b.forma_pagamento) ? b.forma_pagamento : null,
    parcelas_cartao: b.parcelas_cartao ? Number(b.parcelas_cartao) : null, numero_pedido: b.numero_pedido || null,
    previsao_entrega: U.lerData(b.previsao_entrega), entregue_em: U.lerData(b.entregue_em),
    instalacao: STATUS_INSTALACAO.includes(b.instalacao) ? b.instalacao : it.instalacao,
    instalador: b.instalador || null, instalacao_data: U.lerData(b.instalacao_data), nf_ok: b.nf_ok ? 1 : 0, obs_interna: b.obs_interna || null,
  };
  // Avanços automáticos de status a partir das datas.
  if (novo.status === it.status) {
    if (novo.valor_orcado && novo.link && novo.status === 'A orçar') novo.status = 'Orçado';
    if (novo.valor_pago && !it.valor_pago && ['A orçar', 'Orçado', 'Link enviado', 'Revisar'].includes(novo.status)) novo.status = 'Comprado';
    if (novo.entregue_em && ['A orçar', 'Orçado', 'Link enviado', 'Revisar', 'Comprado'].includes(novo.status)) novo.status = 'Entregue';
    if (novo.status === 'Entregue' && ['Concluída', 'Não precisa'].includes(novo.instalacao)) novo.status = 'Concluído';
  }
  if (novo.status === 'Comprado' && !novo.comprado_em) novo.comprado_em = U.hoje();
  if (novo.instalacao === 'Concluída' && !novo.instalacao_data) novo.instalacao_data = U.hoje();
  const diff = mudancas(it, novo, ['obs_interna']);
  salvarItem(it, novo);
  if (diff.length) registrar(u.id, it.id, req.usuario.id, 'Item atualizado', diff.join('; '));
  res.redirect('/itens/' + it.id + '?msg=salvo');
});

app.post('/itens/:id/enviar', exigirLogin, exigirAdmin, (req, res) => {
  const x = itemComAcesso(req, req.params.id);
  if (!x) return erro(req, res, 404, 'Item não encontrado.');
  const { it, u } = x;
  const prop = u.proprietario_id ? db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.proprietario_id) : null;
  if (!prop) return erro(req, res, 400, 'Vincule um proprietário à unidade.');
  const novo = { link_enviado_em: U.agora() };
  if (['A orçar', 'Orçado', 'Revisar'].includes(it.status)) novo.status = 'Link enviado';
  salvarItem(it, novo);
  registrar(u.id, it.id, req.usuario.id, it.link_enviado_em ? 'Link reenviado ao proprietário' : 'Link enviado ao proprietário', `${it.loja || ''} ${moeda(it.valor_orcado)}`.trim());
  res.redirect(`https://wa.me/${U.waNumero(prop.whatsapp)}?text=${encodeURIComponent(mensagemWhatsApp(req, { ...it, ...novo }, u, prop))}`);
});

app.post('/itens/:id/comprei', exigirLogin, subir.single('arquivo'), (req, res) => {
  const x = itemComAcesso(req, req.params.id);
  if (!x) { descartar(req); return erro(req, res, 404, 'Item não encontrado.'); }
  const { it, u } = x;
  const b = req.body;
  const valor = U.lerMoeda(b.valor_pago);
  if (valor === null) { descartar(req); return erro(req, res, 400, 'Informe o valor pago.'); }
  const novo = {
    status: 'Comprado', valor_pago: valor, forma_pagamento: FORMAS_PAGAMENTO.includes(b.forma_pagamento) ? b.forma_pagamento : null,
    parcelas_cartao: b.parcelas_cartao ? Number(b.parcelas_cartao) : null, numero_pedido: b.numero_pedido || null,
    previsao_entrega: U.lerData(b.previsao_entrega), comprado_em: U.hoje(),
  };
  const diff = mudancas(it, novo, ['status', 'comprado_em']);
  salvarItem(it, novo);
  registrar(u.id, it.id, req.usuario.id, 'Compra registrada', diff.join('; '));
  guardarAnexo(req, u, it, 'Comprovante de pagamento');
  res.redirect('/itens/' + it.id + '?msg=comprado');
});

app.post('/itens/:id/acompanhar', exigirLogin, subir.single('arquivo'), (req, res) => {
  const x = itemComAcesso(req, req.params.id);
  if (!x) { descartar(req); return erro(req, res, 404, 'Item não encontrado.'); }
  const { it, u } = x;
  const prev = U.lerData(req.body.previsao_entrega);
  if (prev !== it.previsao_entrega) {
    salvarItem(it, { previsao_entrega: prev });
    registrar(u.id, it.id, req.usuario.id, 'Previsão de entrega atualizada', `${data(it.previsao_entrega) || '—'} → ${data(prev) || '—'}`);
  }
  guardarAnexo(req, u, it, req.body.tipo);
  res.redirect('/itens/' + it.id + '?msg=salvo');
});

app.post('/itens/:id/revisar', exigirLogin, (req, res) => {
  const x = itemComAcesso(req, req.params.id);
  if (!x) return erro(req, res, 404, 'Item não encontrado.');
  const { it, u } = x;
  const msg = String(req.body.msg || '').trim().slice(0, 1000);
  salvarItem(it, { status: 'Revisar', msg_proprietario: msg });
  registrar(u.id, it.id, req.usuario.id, 'Proprietário pediu outra opção', msg);
  res.redirect('/itens/' + it.id + '?msg=revisar');
});

app.post('/itens/:id/anexos', exigirLogin, subir.single('arquivo'), (req, res) => {
  const x = itemComAcesso(req, req.params.id);
  if (!x) { descartar(req); return erro(req, res, 404, 'Item não encontrado.'); }
  if (!guardarAnexo(req, x.u, x.it, req.body.tipo)) return erro(req, res, 400, 'Envie um PDF ou uma imagem de até 15 MB.');
  res.redirect('/itens/' + x.it.id + '?msg=anexo');
});

app.post('/itens/:id/excluir', exigirLogin, exigirAdmin, (req, res) => {
  const x = itemComAcesso(req, req.params.id);
  if (!x) return erro(req, res, 404, 'Item não encontrado.');
  if (!req.body.confirmo) return res.redirect('/itens/' + x.it.id);
  db.prepare('DELETE FROM itens WHERE id = ?').run(x.it.id);
  registrar(x.u.id, null, req.usuario.id, 'Item excluído', x.it.nome);
  res.redirect('/u/' + x.u.id + '?msg=excluido');
});

app.get('/anexos/:id', exigirLogin, (req, res) => {
  const a = db.prepare('SELECT * FROM anexos WHERE id = ?').get(Number(req.params.id));
  if (!a || !unidadeComAcesso(req, a.unidade_id)) return erro(req, res, 404, 'Arquivo não encontrado.');
  const f = path.join(DATA_DIR, 'anexos', path.basename(a.arquivo));
  if (!fs.existsSync(f)) return erro(req, res, 404, 'Arquivo não encontrado.');
  res.set('Content-Type', a.mime || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(a.nome_original || a.arquivo)}"`);
  res.sendFile(f);
});

app.get('/u/:id/exportar.csv', exigirLogin, exigirAdmin, (req, res) => {
  const u = unidadeComAcesso(req, req.params.id);
  if (!u) return erro(req, res, 404, 'Unidade não encontrada.');
  const itens = db.prepare('SELECT * FROM itens WHERE unidade_id = ? ORDER BY ordem, id').all(u.id);
  const cols = ['categoria', 'nome', 'qtd', 'status', 'valor_orcado', 'valor_pago', 'loja', 'link', 'oferta_ate', 'forma_pagamento', 'parcelas_cartao', 'numero_pedido', 'link_enviado_em', 'comprado_em', 'previsao_entrega', 'entregue_em', 'instalacao', 'instalador', 'instalacao_data', 'nf_ok', 'obs_interna'];
  const cel = v => { const s = v === null || v === undefined ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const fmt = (k, v) => ['valor_orcado', 'valor_pago'].includes(k) && v !== null ? String(v).replace('.', ',') : k.endsWith('_em') || k.endsWith('_ate') || k.endsWith('_data') || k === 'previsao_entrega' ? data(v) : k === 'nf_ok' ? (v ? 'sim' : 'não') : v;
  const csv = '﻿' + [cols.map(k => CAMPOS_ITEM[k] || k).join(';'), ...itens.map(i => cols.map(k => cel(fmt(k, i[k]))).join(';'))].join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="unidade-${u.numero}-itens.csv"`);
  res.send(csv);
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return erro(req, res, 400, 'Arquivo inválido: envie um PDF ou uma imagem de até 15 MB.');
  erro(req, res, 500, 'Algo deu errado. Tente de novo.');
});
app.use((req, res) => erro(req, res, 404, 'Página não encontrada.'));

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log('Painel Stay22 na porta ' + PORTA + ' · dados em ' + DATA_DIR));
