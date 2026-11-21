# Painel de montagem · Stay22

Sistema de acompanhamento da montagem das unidades (Edifício Athenas e outros). Fica neste branch (`painel`) para não interferir no site da proposta, que é publicado a partir do `main`.

- **Equipe Stay22** vê todas as unidades, cadastra proprietários, orçamentos e links, envia cada item pelo WhatsApp, controla entregas, instalações, Pacote Stay22, cronograma e documentos.
- **Proprietário** entra com e-mail e senha e vê só a(s) própria(s) unidade(s): itens aguardando compra, botão para a loja, registro da compra com comprovante, entregas, parcelas e cronograma.

## Técnico

- Node 22 + Express, banco SQLite nativo do Node (`node:sqlite`). Sem dados pessoais no repositório: tudo fica no banco do servidor.
- `DATA_DIR`: pasta do banco e dos anexos (no Railway, o volume montado em `/data`).
- Primeiro acesso: abrir `/configurar` para criar a conta de administração (só funciona enquanto não existe nenhuma conta).
- Rodar localmente: `npm install && npm start` (porta 3000).
