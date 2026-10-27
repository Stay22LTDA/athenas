"""Gera a proposta GERAL (index.html na raiz) a partir de _fonte/template.html.
Uso, na raiz do repositório:  python3 _fonte/build_geral.py
"""
import re, os
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGOS = {'{{ATH}}': 'logo-athenas-branca.png', '{{S22W}}': 'logo-stay22-branca.png',
         '{{S22D}}': 'logo-stay22-marrom.png', '{{MMW}}': 'logo-melhor-moveis-branca.png'}

def resolver(t, prefixo):
    for k, f in LOGOS.items():
        t = t.replace(k, prefixo + 'img/' + f)
    return re.sub(r'\{\{IMG:([a-z-]+)\}\}', lambda m: f'{prefixo}img/{m.group(1)}.jpg', t)

def montar(t, head):
    i = t.index('</style>') + len('</style>')
    return head + t[:i] + '\n</head>\n<body>\n' + t[i:] + '\n</body>\n</html>\n'

HEAD_GERAL = '''<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Stay22">
<meta property="og:title" content="Proposta de gestão short stay · Edifício Athenas">
<meta property="og:description" content="Seu flat entregue pronto e gestão individual de cada reserva. Stay22 em parceria com Melhor Móveis.">
<meta property="og:image" content="https://stay22ltda.github.io/athenas/capa-proposta-athenas.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="https://stay22ltda.github.io/athenas/">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#2B2118">
<meta name="description" content="Proposta de gestão short stay da Stay22 em parceria com a Melhor Móveis para o Edifício Athenas.">
'''

if __name__ == '__main__':
    t = open(os.path.join(R, '_fonte/template.html')).read()
    open(os.path.join(R, 'index.html'), 'w').write(montar(resolver(t, ''), HEAD_GERAL))
    print('index.html atualizado')
