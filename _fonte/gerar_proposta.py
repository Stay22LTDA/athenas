"""Gera uma proposta PERSONALIZADA em p/<slug>/ sem tocar na proposta geral.
Uso, na raiz do repositório:  python3 _fonte/gerar_proposta.py caminho/para/proposta.json
Exemplo de JSON em _fonte/exemplo-proposta.json
"""
import json, os, re, sys, secrets, unicodedata
from urllib.parse import quote
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_geral import R, resolver, montar

BASE = 'https://stay22ltda.github.io/athenas/'
PADRAO = {  # valores da tabela geral, por metragem
    '37':    {'marcenaria': 'R$ 30.500', 'compras': 'R$ 28.000', 'pacote': 'R$ 15.000', 'total': 'R$ 73.500'},
    '39,88': {'marcenaria': 'R$ 34.500', 'compras': 'R$ 28.000', 'pacote': 'R$ 15.000', 'total': 'R$ 77.500'},
}
ROTULO_COMPRAS = 'Móveis complementares, decoração, utensílios, enxoval e eletrodomésticos · estimativa'
ROTULO_PACOTE = 'Orçamentos, mão de obra, fotos profissionais e divulgação'

def slugify(nome):
    s = unicodedata.normalize('NFKD', nome.split()[0]).encode('ascii', 'ignore').decode().lower()
    return f"{re.sub(r'[^a-z0-9]+', '', s)}-{secrets.token_hex(2)}"

def trocar(t, a, b):
    assert t.count(a) == 1, f'trecho não encontrado (ou repetido) no modelo: {a[:70]}'
    return t.replace(a, b)

def gerar(cfg):
    nome, unidade, met = cfg['nome'], str(cfg['unidade']), cfg['metragem']
    assert met in PADRAO, 'metragem deve ser "37" ou "39,88"'
    v = {**PADRAO[met], **cfg.get('valores', {})}
    slug = cfg.get('slug') or slugify(nome)
    pasta = os.path.join(R, 'p', slug); os.makedirs(pasta, exist_ok=True)
    url = f'{BASE}p/{slug}/'
    t = open(os.path.join(R, '_fonte/template.html')).read()
    t = re.sub(r'<title>.*?</title>', f'<title>Proposta {nome.split()[0]} · Athenas</title>', t, count=1)
    # abertura
    t = trocar(t, '<div class="eyebrow" style="color:var(--gold-soft)">Edifício Athenas</div>',
               f'<div class="eyebrow" style="color:var(--gold-soft)">Edifício Athenas · Unidade {unidade}</div>')
    t = trocar(t, '<h1 style="margin-top:14px">Proposta de gestão <em>short stay</em></h1>',
               '<h1 style="margin-top:14px">Proposta de gestão <em>short stay</em></h1>\n'
               f'    <p class="para">Proposta exclusiva para <b>{nome}</b></p>')
    if cfg.get('mensagem'):
        t = trocar(t, '<p>Seu flat entregue pronto para receber hóspedes, com gestão individual de cada reserva. Você acompanha tudo em tempo real pelo aplicativo.</p>',
                   f'<p>{cfg["mensagem"]}</p>')
    t = t.replace('/* final */', '.hero p.para{margin:18px 0 0;font-size:17px;color:#F1E6D6;letter-spacing:.02em}\n.hero p.para b{font-weight:500;color:#EBCB8F}\n/* final */', 1)
    # tabela de investimento: só a coluna da unidade
    tabela = re.search(r'    <div class="ptable".*?\n    </div>\n', t, re.S).group(0)
    nova = f'''    <div class="ptable unica" role="table" aria-label="Investimento estimado da unidade {unidade}">
      <div class="pr ph-row" role="row"><span role="columnheader"></span><span role="columnheader">Unidade {unidade} · {met} m²</span></div>
      <div class="pr" role="row"><span role="rowheader"><b>Marcenaria e móveis</b><small>Melhor Móveis</small></span><span role="cell">{v['marcenaria']}</span></div>
      <div class="pr" role="row"><span role="rowheader"><b>Compras</b><small>{ROTULO_COMPRAS}</small></span><span role="cell">{v['compras']}</span></div>
      <div class="pr" role="row"><span role="rowheader"><b>Pacote Stay22</b><small>{ROTULO_PACOTE}</small></span><span role="cell">{v['pacote']}</span></div>
      <div class="pr total" role="row"><span role="rowheader"><b>Total geral estimado</b></span><span role="cell">{v['total']}</span></div>
    </div>
'''
    t = t.replace(tabela, nova)
    t = t.replace('/* final */', '.ptable.unica .pr{grid-template-columns:minmax(0,1fr) auto}\n.ptable.unica .pr.total{grid-template-columns:minmax(0,1fr) auto}\n/* final */', 1)
    # quadro da Melhor Móveis: valor da unidade e o que fica sob responsabilidade dela
    cama = 'king' if met == '39,88' else 'queen'
    t = trocar(t, '<p style="margin-top:12px">Orçamento, contrato, prazo e pagamento diretamente com a Melhor Móveis.</p>',
               f'<p class="mm-valor">{v["marcenaria"]}<small>flat de {met} m² · unidade {unidade}</small></p>\n'
               '        <ul class="mm-lista">'
               '<li>Armário e prateleiras na cozinha</li>'
               '<li>Mesa da sala de jantar</li>'
               '<li>Prateleira com armário e sistema giratório de TV</li>'
               '<li>Porta-malas / escrivaninha</li>'
               '<li>Cabideiro</li>'
               '<li>Cabeceira da cama (painel)</li>'
               f'<li>Cama {cama} com colchão Rondomóveis, sofá-cama e 4 cadeiras de jantar</li>'
               '<li>Projeto, medição, montagem e instalação</li>'
               '<li>Prazo de entrega, garantia e assistência técnica</li></ul>\n'
               '        <p style="margin-top:12px">Orçamento, contrato, prazo e pagamento diretamente com a Melhor Móveis.</p>')
    t = t.replace('/* final */', '.price .mm-valor{margin:14px 0 0;font-family:var(--display);font-size:30px;line-height:1.1;color:inherit}\n'
                  '.price .mm-valor small{display:block;margin-top:6px;font-family:var(--body);font-size:13px;letter-spacing:.04em;opacity:.7}\n'
                  '.price .mm-lista{margin:14px 0 0;padding-left:18px;font-size:14px;line-height:1.6}\n/* final */', 1)
    # cama: só o tamanho da unidade, sem citar o outro
    t = trocar(t, '<li>Cama com colchão Rondomóveis*</li>', f'<li>Cama {cama} com colchão Rondomóveis</li>')
    t = trocar(t, '<p class="note">* Cama king nos flats de 39,88 m² e queen nos flats de 37 m².</p>', '')
    cond = cfg.get('condicoes') or 'Condições de pagamento a combinar.'
    if cfg.get('validade'):
        cond += f' Proposta válida até {cfg["validade"]}.'
    t = trocar(t, 'Condições de pagamento a combinar.</p></div>', f'{cond}</p></div>')
    # WhatsApp já identifica o proprietário
    t = t.replace('Ol%C3%A1%21%20Vi%20a%20proposta', quote(f'Olá! Aqui é {nome}, da unidade {unidade}. Vi a proposta'))
    t = resolver(t, '../../')
    head = f'''<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Stay22">
<meta property="og:title" content="Proposta exclusiva · {nome}">
<meta property="og:description" content="Edifício Athenas · Unidade {unidade}. Gestão short stay Stay22 em parceria com Melhor Móveis.">
<meta property="og:image" content="{url}capa.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="{url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#2B2118">
'''
    open(os.path.join(pasta, 'index.html'), 'w').write(montar(t, head))
    capa(nome, unidade, os.path.join(pasta, 'capa.jpg'))
    return url

def capa(nome, unidade, destino):
    from PIL import Image, ImageDraw, ImageFont
    G = '/usr/share/fonts/truetype/google-fonts/'
    def fonte(n, s):
        try: return ImageFont.truetype(G + n, s)
        except OSError: return ImageFont.load_default(s)
    W, H = 1200, 630
    ink, cream, gold, muted = (43, 33, 24), (241, 230, 214), (201, 169, 110), (201, 185, 162)
    im = Image.new('RGB', (W, H), ink); d = ImageDraw.Draw(im); L = 72
    d.rectangle([28, 28, W - 28, H - 28], outline=(110, 88, 62), width=1)
    d.text((L, 72), 'P R O P O S T A   E X C L U S I V A', font=fonte('Poppins-Regular.ttf', 18), fill=gold)
    d.text((L, 108), 'Proposta de gestão', font=fonte('Lora-Variable.ttf', 66), fill=cream)
    d.text((L, 188), 'short stay', font=fonte('Lora-Italic-Variable.ttf', 66), fill=gold)
    d.line([(L, 292), (L + 60, 292)], fill=gold, width=2)
    d.text((L, 306), f'Para {nome}', font=fonte('Poppins-Medium.ttf', 23), fill=cream)
    d.text((L, 340), f'Edifício Athenas · Unidade {unidade}', font=fonte('Poppins-Light.ttf', 21), fill=muted)
    fb = fonte('Poppins-Medium.ttf', 21); lab = 'CLIQUE AQUI E CONHEÇA A PROPOSTA'
    tw = d.textlength(lab, font=fb); bx1 = L + int(tw) + 88
    d.rounded_rectangle([L, 392, bx1, 450], radius=4, fill=(168, 131, 74))
    d.text((L + 28, 407), lab, font=fb, fill='white')
    ax = L + 28 + int(tw) + 16; ay = 421
    d.line([(ax, ay), (ax + 22, ay)], fill='white', width=3)
    d.line([(ax + 14, ay - 7), (ax + 22, ay), (ax + 14, ay + 7)], fill='white', width=3)
    img = os.path.join(R, 'img')
    def colar(f, h, x, y):
        lg = Image.open(os.path.join(img, f)).convert('RGBA'); r = h / lg.height
        lg = lg.resize((int(lg.width * r), h), Image.LANCZOS); im.paste(lg, (x, y), lg); return lg.width
    w = colar('logo-stay22-branca.png', 70, L, 498)
    d.text((L + w + 26, 524), 'EM PARCERIA COM', font=fonte('Poppins-Regular.ttf', 14), fill=muted)
    colar('logo-melhor-moveis-branca.png', 86, L + w + 196, 490)
    lg = Image.open(os.path.join(img, 'logo-athenas-bege-claro.png')).convert('RGBA'); tw2 = 320
    lg = lg.resize((tw2, int(lg.height * tw2 / lg.width)), Image.LANCZOS)
    im.paste(lg, (W - tw2 - 80, (H - lg.height) // 2), lg)
    d.line([(W - tw2 - 120, 110), (W - tw2 - 120, H - 110)], fill=(90, 72, 52), width=1)
    im.save(destino, quality=88)

if __name__ == '__main__':
    print(gerar(json.load(open(sys.argv[1]))))
