# CI.TECH — Editor de Posts + Galeria

Editor livre (estilo Canva) pra montar artes de Instagram a partir de pedaços — texto, foto do produto, logo, formas/emblemas — cada um movível/redimensionável/rotacionável. Dá pra salvar qualquer montagem como **template** reutilizável (a próxima vez, carrega o template e só troca a foto/texto) e guardar as artes prontas numa galeria com banco SQLite.

- `public/index.html` — o editor (tela inicial com os templates salvos → monta a arte → baixar / compartilhar / salvar na galeria / salvar como template)
- `public/gallery.html` — galeria das artes salvas
- `public/users.html`, `public/login.html` — controle de acesso
- `server.js` — API (Express + better-sqlite3 + multer + bcryptjs), serve os arquivos estáticos acima
- SQLite fica em `data/posts.sqlite`, as imagens e miniaturas de template em `uploads/` — os dois são pensados pra viver fora do container (bind mount), igual ao padrão do `sistema-Mrosc`.

## Como funciona o editor

Internamente usa [Konva.js](https://konvajs.org/) (canvas, via CDN) pra arrastar/redimensionar/rotacionar os elementos. Cada arte é um fundo (imagem ou cor sólida) + uma lista de camadas:
- **Texto** — conteúdo, fonte (9 opções via Google Fonts), peso, tamanho, cor, sólido ou contorno, itálico.
- **Foto** — a foto do produto (ou qualquer imagem), com raio de borda ajustável.
- **Logo** — a logo da CI.TECH como camada fixa.
- **Forma/emblema** — retângulo colorido com cantos arredondados e texto centralizado (ex: "OFERTA", "-20%").

Ao salvar como template, camadas de foto que o usuário subiu viram "placeholder" (a imagem em si não é salva, só a posição/tamanho) — ao carregar esse template de novo, o app pede pra subir uma foto nova pra preencher o espaço. A logo e outros elementos fixos continuam iguais.

Os 3 templates originais (Chegou Novidade / Tem Promoção / Nossos Produtos) são recriados automaticamente no primeiro boot, caso a tabela `templates` esteja vazia.

## Rodar local (sem Docker)

```bash
npm install
npm start
```

Abre em `http://localhost:3010`.

## Rodar com Docker

```bash
mkdir -p data uploads   # se ainda não existirem
docker compose up -d --build
```

Isso sobe o container na porta `8091` do host (configurável no `docker-compose.yml`), com o SQLite e os uploads persistidos fora do container.

## Login e controle de acesso

Toda a aplicação (gerador, galeria, API) fica atrás de login. No primeiro boot, se não existir nenhum usuário no banco, um usuário admin é criado automaticamente — as credenciais aparecem uma vez no log:

```bash
docker compose logs citech-posts
```

Pra fixar usuário/senha iniciais em vez de deixar gerar sozinho, defina `ADMIN_USERNAME`/`ADMIN_PASSWORD` no `docker-compose.yml` antes do primeiro `up`.

Depois de logado, qualquer usuário pode adicionar ou remover outros em **👤 Usuários** (não dá pra remover o próprio usuário logado nem o último usuário que sobrar, pra não trancar o acesso).

## Publicar num subdomínio (Cloudflare Tunnel)

Isso aqui eu não apliquei — depende do túnel/config que já está sendo gerenciado na conversa "Configurar Servidores Docker". O que falta fazer lá, resumido:

1. Escolher o subdomínio (ex: `posts.seudominio.com.br`).
2. No `config.yml` do `cloudflared` (geralmente em `/etc/cloudflared/config.yml` ou `~/.cloudflared/config.yml`), adicionar uma regra de ingress apontando pro serviço:

   ```yaml
   ingress:
     - hostname: posts.seudominio.com.br
       service: http://localhost:8091   # ou http://citech-posts:3010 se estiver na mesma rede Docker do túnel
     # ... resto das regras existentes
     - service: http_status:404
   ```

3. Criar o registro DNS do subdomínio apontando pro túnel (`cloudflared tunnel route dns <tunnel-id> posts.seudominio.com.br`).
4. Reiniciar o `cloudflared`.

Se o túnel já roda via Docker Compose na mesma rede, o mais simples é colocar o `citech-posts` na mesma `network:` externa do cloudflared e usar o nome do serviço (`http://citech-posts:3010`) em vez de `localhost`, sem precisar nem publicar a porta no host.

Depois de publicado em HTTPS, mude `COOKIE_SECURE` pra `true` no `docker-compose.yml` e suba de novo (`docker compose up -d --build`) — isso faz o cookie de login só trafegar por conexão segura.

## Por que o compartilhamento direto pro Instagram só funciona hospedado

O botão "📤 Compartilhar" usa a Web Share API do navegador, que só libera compartilhamento de arquivos em contexto seguro (HTTPS, ou localhost). Abrindo o `index.html` como arquivo local isso pode não funcionar dependendo do navegador do celular — uma vez publicado em HTTPS (o subdomínio acima), funciona de forma confiável em Android/iOS.

## Limitações conhecidas do editor (v1)

- Redimensionar foto/logo trava a proporção (sem recorte fino tipo Canva).
- Sem desfazer/refazer (undo/redo) nem atalhos de teclado.
- "Salvar como template" sempre cria um novo registro (não sobrescreve o template carregado) — a API já suporta `PUT /api/templates/:id` pra isso, só não tem botão na interface ainda.

## Próximos passos possíveis

- Editar/renomear o nome do produto depois de salvo na galeria.
- Busca por nome de produto na galeria.
- Botão "Atualizar este template" (sobrescrever em vez de sempre criar novo).
- Camadas de múltiplas fotos por template, reordenar/duplicar camadas.
