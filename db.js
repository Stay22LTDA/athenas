// Banco de dados (SQLite nativo do Node) e modelos padrão da montagem.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'anexos'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'painel.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  whatsapp TEXT,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('admin','proprietario')),
  ativo INTEGER NOT NULL DEFAULT 1,
  trocar_senha INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS unidades (
  id INTEGER PRIMARY KEY,
  numero TEXT NOT NULL,
  edificio TEXT NOT NULL DEFAULT 'Edifício Athenas',
  proprietario_id INTEGER REFERENCES usuarios(id),
  area TEXT,
  data_assinatura TEXT,
  prazo_dias INTEGER NOT NULL DEFAULT 120,
  verba_estimada REAL NOT NULL DEFAULT 0,
  pacote_valor REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Em montagem',
  endereco_entrega TEXT,
  obs_interna TEXT,
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS itens (
  id INTEGER PRIMARY KEY,
  unidade_id INTEGER NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 0,
  categoria TEXT NOT NULL,
  nome TEXT NOT NULL,
  qtd TEXT,
  status TEXT NOT NULL DEFAULT 'A orçar',
  valor_orcado REAL,
  valor_pago REAL,
  loja TEXT,
  link TEXT,
  oferta_ate TEXT,
  forma_pagamento TEXT,
  parcelas_cartao INTEGER,
  numero_pedido TEXT,
  link_enviado_em TEXT,
  comprado_em TEXT,
  previsao_entrega TEXT,
  entregue_em TEXT,
  instalacao TEXT NOT NULL DEFAULT 'Não precisa',
  instalador TEXT,
  instalacao_data TEXT,
  nf_ok INTEGER NOT NULL DEFAULT 0,
  msg_proprietario TEXT,
  obs_interna TEXT,
  atualizado_em TEXT
);
CREATE TABLE IF NOT EXISTS parcelas (
  id INTEGER PRIMARY KEY,
  unidade_id INTEGER NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 0,
  descricao TEXT NOT NULL,
  vencimento TEXT,
  valor REAL NOT NULL,
  pago_em TEXT
);
CREATE TABLE IF NOT EXISTS etapas (
  id INTEGER PRIMARY KEY,
  unidade_id INTEGER NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 0,
  nome TEXT NOT NULL,
  responsavel TEXT,
  prazo TEXT,
  status TEXT NOT NULL DEFAULT 'Pendente',
  concluida_em TEXT,
  obs TEXT
);
CREATE TABLE IF NOT EXISTS anexos (
  id INTEGER PRIMARY KEY,
  unidade_id INTEGER NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES itens(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL,
  arquivo TEXT NOT NULL,
  nome_original TEXT,
  mime TEXT,
  enviado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS historico (
  id INTEGER PRIMARY KEY,
  unidade_id INTEGER REFERENCES unidades(id) ON DELETE CASCADE,
  item_id INTEGER,
  usuario_id INTEGER,
  acao TEXT NOT NULL,
  detalhes TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_itens_unidade ON itens(unidade_id);
CREATE INDEX IF NOT EXISTS idx_hist_unidade ON historico(unidade_id, id);
`);

// Segredo das sessões: gerado uma vez e guardado no próprio banco.
function segredo() {
  const r = db.prepare("SELECT valor FROM config WHERE chave='segredo'").get();
  if (r) return r.valor;
  const s = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO config (chave, valor) VALUES ('segredo', ?)").run(s);
  return s;
}

// Escopo do Anexo I do Contrato de Implantação (categoria, item, qtd, montagem/instalação).
const ITENS_PADRAO = [
  ['Móveis complementares', 'Cadeira de escritório giratória (mesa de trabalho)', '1', 'Pendente'],
  ['Eletrodomésticos', 'Ar-condicionado', '1', 'Pendente'],
  ['Eletrodomésticos', 'TV 50"', '1', 'Pendente'],
  ['Eletrodomésticos', 'Geladeira', '1', 'Não precisa'],
  ['Eletrodomésticos', 'Micro-ondas', '1', 'Não precisa'],
  ['Eletrodomésticos', 'Sanduicheira', '1', 'Não precisa'],
  ['Eletrodomésticos', 'Liquidificador', '1', 'Não precisa'],
  ['Eletrodomésticos', 'Cafeteira', '1', 'Não precisa'],
  ['Eletrodomésticos', 'Cooktop 2 bocas', '1', 'Pendente'],
  ['Eletrodomésticos', 'Secador de cabelo', '1', 'Não precisa'],
  ['Decoração', 'Adornos (cerca de 20)', '20', 'Pendente'],
  ['Decoração', 'Pendente – quarto', '1', 'Pendente'],
  ['Decoração', 'Pendente – sala', '1', 'Pendente'],
  ['Decoração', 'Pendente – banheiro', '1', 'Pendente'],
  ['Decoração', 'Espelho – quarto', '1', 'Pendente'],
  ['Decoração', 'Espelho – banheiro', '1', 'Pendente'],
  ['Decoração', 'Spots de iluminação', '', 'Pendente'],
  ['Decoração', 'Papel de parede – cozinha', '', 'Pendente'],
  ['Decoração', 'Papel de parede – quarto', '', 'Pendente'],
  ['Decoração', 'Tinta verde – parede da sala', '', 'Pendente'],
  ['Decoração', 'Cortina – janela', '1', 'Pendente'],
  ['Decoração', 'Cortina – porta da varanda', '1', 'Pendente'],
  ['Utensílios', 'Jogo de panelas (5 peças)', '1', 'Não precisa'],
  ['Utensílios', 'Jogo de copos (6)', '1', 'Não precisa'],
  ['Utensílios', 'Jogo de talheres (24 peças)', '1', 'Não precisa'],
  ['Utensílios', 'Jogo de taças (4)', '1', 'Não precisa'],
  ['Utensílios', 'Jogo de café (8 peças)', '1', 'Não precisa'],
  ['Utensílios', 'Kit de facas (5 peças)', '1', 'Não precisa'],
  ['Utensílios', 'Kit de espátulas (6 peças)', '1', 'Não precisa'],
  ['Utensílios', 'Escorredor de louças', '1', 'Não precisa'],
  ['Utensílios', 'Abridor de latas', '1', 'Não precisa'],
  ['Utensílios', 'Abridor de vinho', '1', 'Não precisa'],
  ['Enxoval', 'Travesseiros', '6', 'Não precisa'],
  ['Enxoval', 'Jogos de cama', '4', 'Não precisa'],
  ['Enxoval', 'Edredons de casal', '2', 'Não precisa'],
  ['Enxoval', 'Mantas de casal', '2', 'Não precisa'],
  ['Enxoval', 'Jogos de toalhas', '6', 'Não precisa'],
  ['Enxoval', 'Panos de prato', '5', 'Não precisa'],
];

// [nome, responsável, prazo em dias após a assinatura (null = sem prazo; 'P' = prazo de entrega)]
const ETAPAS_PADRAO = [
  ['Assinatura dos contratos', 'Stay22 + proprietário', 0],
  ['Entrega das chaves, acesso e autorizações do condomínio', 'Proprietário', 5],
  ['Orçamentos enviados ao proprietário', 'Stay22', null],
  ['Compras realizadas e pagas', 'Proprietário', null],
  ['Marcenaria e móveis – projeto e contrato', 'Proprietário + Melhor Móveis', null],
  ['Marcenaria e móveis – entrega e instalação', 'Melhor Móveis', null],
  ['Pintura decorativa (detalhes)', 'Stay22', null],
  ['Aplicação do papel de parede', 'Stay22', null],
  ['Instalação elétrica de luminárias, pendentes e spots', 'Stay22', null],
  ['Instalação do ar-condicionado', 'Stay22', null],
  ['Montagem de eletrodomésticos e móveis', 'Stay22', null],
  ['Cortinas, espelhos e adornos instalados', 'Stay22', null],
  ['Utensílios e enxoval conferidos', 'Stay22', null],
  ['Fotos profissionais', 'Stay22', null],
  ['Anúncios criados nas plataformas', 'Stay22', null],
  ['Vistoria de entrada e Termo de Entrega', 'Stay22 + proprietário', 'P'],
  ['Prestação de contas das compras', 'Stay22', 'P'],
];

const STATUS_ITEM = ['A orçar', 'Orçado', 'Link enviado', 'Revisar', 'Comprado', 'Entregue', 'Concluído', 'Cancelado'];
const STATUS_INSTALACAO = ['Não precisa', 'Pendente', 'Agendada', 'Concluída'];
const STATUS_ETAPA = ['Pendente', 'Em andamento', 'Concluída', 'Bloqueada'];
const FORMAS_PAGAMENTO = ['PIX', 'Cartão à vista', 'Cartão parcelado', 'Boleto', 'Transferência', 'Outro'];
const TIPOS_ANEXO = ['Nota fiscal', 'Comprovante de pagamento', 'Foto', 'Orçamento', 'Outro'];

module.exports = {
  db, DATA_DIR, segredo, ITENS_PADRAO, ETAPAS_PADRAO,
  STATUS_ITEM, STATUS_INSTALACAO, STATUS_ETAPA, FORMAS_PAGAMENTO, TIPOS_ANEXO,
};
