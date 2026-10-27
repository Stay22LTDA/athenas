# Proposta Athenas · Stay22

Site da proposta de gestão short stay da Stay22 (em parceria com a Melhor Móveis) para proprietários do Edifício Athenas. Publicado pelo GitHub Pages em https://stay22ltda.github.io/athenas/ a partir do branch `main`.

## Estrutura

- `index.html`: proposta GERAL. Não editar à mão: é gerada.
- `_fonte/template.html`: fonte única do conteúdo e do visual. Logos e fotos aparecem como marcadores (`{{ATH}}`, `{{S22W}}`, `{{S22D}}`, `{{MMW}}`, `{{IMG:nome}}`).
- `_fonte/build_geral.py`: gera `index.html` a partir do modelo (`python3 _fonte/build_geral.py`).
- `_fonte/gerar_proposta.py`: gera uma proposta PERSONALIZADA em `p/<slug>/` (página + `capa.jpg` para o WhatsApp) sem tocar na geral. Uso: `python3 _fonte/gerar_proposta.py proposta.json`. Modelo de JSON em `_fonte/exemplo-proposta.json`.
- `img/`: renders e logos. `capa-proposta-athenas.jpg`: cartão de prévia da proposta geral.
- `p/<slug>/`: propostas personalizadas já enviadas. Não apagar nem alterar uma proposta enviada sem pedido explícito.

## Regras

- Mudança só para um proprietário: gere com `gerar_proposta.py`. Nunca altere `_fonte/template.html` nem `index.html` para isso.
- Mudança que vale para todos: edite `_fonte/template.html`, rode `build_geral.py` e, se a proprietária pedir, regenere as propostas personalizadas existentes.
- O repositório é PÚBLICO. Nas propostas, só nome, unidade, metragem, valores, condições, validade e mensagem. Nunca CPF, RG, telefone, e-mail, endereço ou dados de contrato.
- Slug com sufixo aleatório (o gerador cria, ex.: `carlos-7k3f`). As páginas personalizadas têm `noindex`.
- Antes de publicar, confira no navegador (Playwright, Chromium em /opt/pw-browsers) a 390 px e a 1280 px: sem rolagem lateral e com imagens carregando.
- Commit e push direto no `main` (autor `Stay22LTDA`). O Pages atualiza em 1 a 2 minutos.
- Responder em português do Brasil. Downloads de arquivos costumam falhar para a usuária: entregue sempre o link da página e mostre a imagem do cartão no chat.

## Dados de referência

- Metragem pelo final da unidade (fonte: material da Conceito; confirmar com o proprietário): finais 1 e 4 = 37 m² (cama queen); 2 e 3 = 39,88 m² (king); 5 e 6 = 39,88 m² (king, com vista).
- Valores padrão: 37 m² = Melhor Móveis R$ 30.500 + Compras R$ 28.000 (estimativa) + Pacote Stay22 R$ 15.000 = R$ 73.500. 39,88 m² = R$ 34.500 + R$ 28.000 + R$ 15.000 = R$ 77.500.
- Administração Stay22: 20% sobre o faturamento. Prazo: 120 dias a partir da assinatura do contrato. Gestão individual por unidade, sem pool.
- WhatsApp Stay22: +55 35 98846-4111. Instagram: @stay22.gestao.
