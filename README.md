# CI.TECH — Gerador de Posts + Galeria

App simples pra gerar artes de Instagram (Chegou Novidade / Tem Promoção / Nossos Produtos) a partir de fotos de produto, e guardar as artes prontas numa galeria com banco SQLite.

- `public/index.html` — gerador (upload da foto → encaixa no frame → baixar / compartilhar / salvar na galeria)
- `public/gallery.html` — galeria das artes salvas
- `server.js` — API (Express + better-sqlite3 + multer), serve os arquivos estáticos acima
- SQLite fica em `data/posts.sqlite`, as imagens em `uploads/` — os dois são pensados pra viver fora do container (bind mount), igual ao padrão do `sistema-Mrosc`.

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

Isso sobe o container na porta `8090` do host (configurável no `docker-compose.yml`), com o SQLite e os uploads persistidos fora do container.

## Publicar num subdomínio (Cloudflare Tunnel)

Isso aqui eu não apliquei — depende do túnel/config que já está sendo gerenciado na conversa "Configurar Servidores Docker". O que falta fazer lá, resumido:

1. Escolher o subdomínio (ex: `posts.seudominio.com.br`).
2. No `config.yml` do `cloudflared` (geralmente em `/etc/cloudflared/config.yml` ou `~/.cloudflared/config.yml`), adicionar uma regra de ingress apontando pro serviço:

   ```yaml
   ingress:
     - hostname: posts.seudominio.com.br
       service: http://localhost:8090   # ou http://citech-posts:3010 se estiver na mesma rede Docker do túnel
     # ... resto das regras existentes
     - service: http_status:404
   ```

3. Criar o registro DNS do subdomínio apontando pro túnel (`cloudflared tunnel route dns <tunnel-id> posts.seudominio.com.br`).
4. Reiniciar o `cloudflared`.

Se o túnel já roda via Docker Compose na mesma rede, o mais simples é colocar o `citech-posts` na mesma `network:` externa do cloudflared e usar o nome do serviço (`http://citech-posts:3010`) em vez de `localhost`, sem precisar nem publicar a porta no host.

## Por que o compartilhamento direto pro Instagram só funciona hospedado

O botão "📤 Compartilhar" usa a Web Share API do navegador, que só libera compartilhamento de arquivos em contexto seguro (HTTPS, ou localhost). Abrindo o `index.html` como arquivo local isso pode não funcionar dependendo do navegador do celular — uma vez publicado em HTTPS (o subdomínio acima), funciona de forma confiável em Android/iOS.

## Próximos passos possíveis

- Autenticação simples (se a galeria não puder ficar pública).
- Editar/renomear o nome do produto depois de salvo.
- Busca por nome de produto na galeria.
