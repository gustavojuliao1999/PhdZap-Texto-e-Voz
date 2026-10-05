# PhdZap

Central de atendimento por WhatsApp (mensagens e ligações de voz) sobre o [`baileys-caller`](baileys-caller):

- **Painel** com login de usuários, **grupos e permissões por telefone**: várias **linhas**
  (telefones), cada uma com QR de pareamento, **token próprio** e configurações.
- **PostgreSQL + Prisma** e **Docker Compose** prontos.
- **Iframes** para colocar em qualquer site:
  - **Receptor**: a ligação toca em todos os atendentes; **o primeiro a atender fica na ligação**.
  - **Discador**: faz ligações pela linha.
- **API REST + WebSocket** por linha (token da linha) e API de gestão (chave de acesso).
- **Mensagens** (texto, áudio de voz, imagem, vídeo, documento, localização) pela mesma conexão
  das ligações, com histórico e **webhook** assinado para mensagens e ligações.
- **Bot/IA**: atendimento automático com a ponte de mídia em tempo real (`ws-bridge`).

```
navegador/site ──iframes/API──┐
                              ▼
                     processo principal (painel, API, WS)
                     ├── linha "Vendas"  → processo próprio → WhatsApp (WASM VoIP)
                     ├── linha "Suporte" → processo próprio → WhatsApp (WASM VoIP)
                     └── ...
```

Cada linha roda num processo separado (o stack de voz do WhatsApp só permite uma
instância por processo). Se uma linha cair, ela é reiniciada sozinha sem afetar as outras.

## Rodando com Docker (recomendado)

Requisitos: Docker com Compose. O código do `baileys-caller` vem junto no repositório, na pasta
`./baileys-caller` (com o `dist/` já compilado): basta clonar e subir.

```bash
git clone https://github.com/gustavojuliao1999/PhdZap-Texto-e-Voz.git
cd PhdZap-Texto-e-Voz
cp .env.example .env
# edite o .env: ADMIN_API_KEY (super admin) e POSTGRES_PASSWORD
docker compose up -d --build
```

**Para atualizar** (gateway e baileys-caller juntos): `git pull && ./scripts/deploy.sh`. O deploy
reconstrói a imagem e recria o container sozinho, só reinicia se algo mudou e volta para a imagem
anterior se a nova não subir. Para usar o baileys-caller de outra pasta, defina
`BAILEYS_CALLER=/caminho/da/pasta` no `.env`.

Abra **http://localhost:3000/**, clique em **Entrar com chave de acesso** e use a `ADMIN_API_KEY`.

- `db`: PostgreSQL 16, com dados no volume `pgdata`.
- `app`: o gateway. As migrações do banco são aplicadas sozinhas ao iniciar. As sessões do WhatsApp
  ficam no volume `appdata` (`/data`). **Não apague esse volume**, senão será preciso ler o QR de novo.
- Logs: `docker compose logs -f app` · diagnóstico de chamadas: `VOIP_DEBUG=1` no `.env`.

## Rodando sem Docker (desenvolvimento)

Requisitos: Node.js ≥ 20, `ffmpeg` no PATH, `./baileys-caller` compilado (`npm run build` lá) e um
PostgreSQL. O do compose serve: `docker compose up -d db`.

```bash
npm install
cp .env.example .env          # ajuste DATABASE_URL e ADMIN_API_KEY
npm run db:migrate            # cria as tabelas
npm start
```

Ao iniciar pela primeira vez, os dados da versão anterior (`data/lines.json`, `data/calls.jsonl`
e a pasta `./auth`) são importados para o banco automaticamente.

## Usuários, grupos e permissões

- **Super admin:** entra com a `ADMIN_API_KEY` do `.env` e tem acesso total. Use-o para criar os
  primeiros usuários.
- **Usuários** entram com usuário e senha (o hash é scrypt). Um usuário marcado como
  **administrador** gerencia telefones, usuários e grupos e tem acesso a todos os telefones.
- **Grupos** recebem permissões **por telefone**. Um usuário pode estar em vários grupos e as
  permissões se somam:

| Permissão | O que libera |
|---|---|
| Ver | o telefone e o histórico dele |
| Receber | atender e recusar ligações |
| Ligar | fazer ligações |
| Mensagens | ver e enviar mensagens |
| Conectar | ler o QR, desconectar e reiniciar o telefone |
| Configurar | alterar as configurações do telefone |
| Integrações | ver o token, os códigos de iframe/SDK e a API, e gerar um novo token |

  Há perfis prontos na tela de grupos: Atendente (ver, receber, ligar, mensagens), Só receber, Supervisor
  (+ conectar), Gerente (tudo) e Só ver.
- No painel, os iframes de atendimento usam o **login** do usuário, não o token da linha. Assim,
  um atendente nunca vê o token. Ele atende e liga com o próprio nome, que aparece no histórico.
- Trocar a senha ou desativar um usuário encerra as sessões dele. Mudanças de permissão valem na hora.

## Incorporando em outro site

No painel, abra **Incorporar** na linha e copie os códigos:

```html
<iframe src="https://SEU_GATEWAY/embed/receiver?token=TOKEN_DA_LINHA&agent=Maria"
        allow="microphone; camera; display-capture; autoplay" style="width:360px;height:420px;border:0"></iframe>

<iframe src="https://SEU_GATEWAY/embed/dialer?token=TOKEN_DA_LINHA&agent=Maria"
        allow="microphone; camera; display-capture; autoplay" style="width:360px;height:480px;border:0"></iframe>
```

- `agent` é o nome do atendente. Ele aparece para os outros atendentes ("Atendida por Maria") e no histórico.
- `allow="microphone; camera; display-capture; autoplay"`: `microphone` e `autoplay` são obrigatórios;
  `camera` e `display-capture` servem para ligar com vídeo (câmera ou tela). O gateway **e o site que
  incorpora** precisam estar em HTTPS (veja [HTTPS](#https)).
- Em **Configurar › Sites que podem incorporar**, restrinja quais domínios podem usar a linha.
  Isso vale para o `frame-ancestors` dos iframes e para a origem nas chamadas à API.
- O som do toque só funciona depois de uma interação com o iframe (política de autoplay). O
  receptor mostra um botão "Ativar".

O iframe avisa a página que o incorporou via `postMessage`:

```js
window.addEventListener("message", (e) => {
  if (e.data?.source !== "whatsapp-voice-gateway") return;
  // e.data.type: incoming | answered | answered-elsewhere | connected | ended | dialing
  console.log(e.data.type, e.data.call); // { id, remote, pushName, direction, status, ownerAgent, ... }
});
```

## Integração por JavaScript (sem iframe)

Para sites onde o iframe não funciona, ou para ter uma interface própria, inclua o SDK.
Ele não desenha nada na tela, só emite eventos e oferece métodos. O HTML e o CSS ficam por sua conta.

```html
<script src="https://SEU_GATEWAY/sdk.js"></script>
<script>
  const phone = WhatsAppVoice.connect({ token: "TOKEN_DA_LINHA", agent: "Maria" });

  phone.on("incoming", (call) => mostrarTela(call));         // toca em todos
  phone.on("answered-elsewhere", () => esconderTela());      // outro atendeu antes
  phone.on("connected", (call) => mostrarEmLigacao(call));
  phone.on("ended", () => esconderTela());

  botaoAtender.onclick  = () => phone.answer();              // o 1º a atender leva
  botaoDesligar.onclick = () => phone.hangup();
  botaoLigar.onclick    = () => phone.dial("5581992338229");
</script>
```

- **Eventos:** `ready`, `line`, `incoming`, `answered`, `answered-elsewhere`, `dialing`, `connected`, `ended`, `busy`,
  `levels`, `error`.
- **Métodos:** `answer()`, `reject()`, `ignore()`, `dial(numero)`, `hangup()`, `mute()`, `unlockAudio()`, `history()`, `destroy()`.
- O SDK já toca o toque de chamada recebida e o "chamando". Para usar sons próprios, desligue com
  `{ ringtone: false, ringback: false }`.
- **Exemplo completo em HTML + CSS:** [`examples/sdk-exemplo.html`](examples/sdk-exemplo.html) é um telefone flutuante
  no canto da página. No painel, a aba **JavaScript** de cada telefone baixa esse exemplo já preenchido com
  a URL e o token, e tem uma demonstração ao vivo (`/sdk/demo`).
- O site precisa estar em **HTTPS** (ou localhost) para o microfone funcionar. Se a linha tiver
  "Sites permitidos", inclua o domínio do site.

## API

> **Documentação completa:** [docs/API.md](docs/API.md) (REST, WebSocket, áudio, ponte de IA, gestão)
> e [docs/WEBHOOK.md](docs/WEBHOOK.md) (eventos, assinatura, exemplos em Node, PHP e Python).

Todas as rotas da linha usam `Authorization: Bearer <token da linha>` (ou `?token=`).
A aba **API** de cada linha no painel mostra os exemplos prontos com a URL certa.

| Método | Rota | Corpo | |
|---|---|---|---|
| GET  | `/api/v1/line` | | estado da linha |
| GET  | `/api/v1/calls` | | chamada atual + histórico |
| POST | `/api/v1/calls` | `{to, handler?, clientId?, agent?}` | ligar |
| POST | `/api/v1/calls/:id/accept` | `{clientId?, agent?, handler?}` | atender (o 1º leva; os outros recebem 409) |
| POST | `/api/v1/calls/:id/reject` · `/hangup` · `/clear` | | |
| POST | `/api/v1/calls/:id/mute` | `{muted}` | |
| POST | `/api/v1/calls/:id/play` | `{url}` | toca um áudio na ligação |
| GET  | `/api/v1/messages?contact=&limit=&before=` | | mensagens, mais recentes primeiro |
| POST | `/api/v1/messages` | `{to, text}` ou `{to, type, url \| base64, caption?, fileName?, ptt?}` | envia mensagem (`replyTo` opcional) |
| GET  | `/api/v1/messages/:id/media` | | baixa a mídia da mensagem |
| POST | `/api/v1/messages/:id/read` | | marca como lida no WhatsApp |
| GET  | `/api/v1/chats` | | conversas: última mensagem, nome e não lidas |
| POST | `/api/v1/chats/:numero/read` | | marca a conversa como lida |
| WS   | `/api/v1/events?token=` | | `hello`, `incoming`, `dialing`, `answered`, `connected`, `ended`, `busy`, `line`, `message`, `message-status` |
| WS   | `/api/v1/media?token=&call=&clientId=` | | áudio PCM16 LE mono 16 kHz nos dois sentidos |

`handler`: `browser` (áudio via `/api/v1/media`), `echo`, `silence`, `ws-bridge` (IA).

Gestão (chave de acesso, `Authorization: Bearer <chave>`): `GET/POST /admin/api/lines`,
`PATCH/DELETE /admin/api/lines/:id`, `POST /admin/api/lines/:id/{logout,restart,rotate-token}`,
`GET /admin/api/calls`, `POST /admin/api/lines/:id/webhook-test`.

## Som do toque (autoplay)

Os navegadores só tocam som depois de uma interação com a página. Por isso o receptor libera o
toque no **primeiro clique ou tecla em qualquer lugar**: dentro dele ou na página que o incorpora,
desde que o iframe tenha `allow="autoplay"`. O SDK faz o mesmo sozinho. Ao abrir o painel, basta um
clique em qualquer coisa.

Para não precisar nem desse clique:

- **Alertas do sistema:** na página do telefone, clique em **🔔 Ativar alertas** uma vez. Com a aba
  em segundo plano, ligações e mensagens novas aparecem como notificação do sistema, com o som do
  sistema e sem precisar de clique.
- **Liberar o site no navegador** dos computadores dos atendentes:
  - **Chrome:** política `AutoplayAllowlist`. No Linux, crie
    `/etc/opt/chrome/policies/managed/autoplay.json` com
    `{"AutoplayAllowlist": ["https://SEU_GATEWAY"]}` (no Windows, use GPO ou o registro). Confira em
    `chrome://policy`.
  - **Edge:** `edge://settings/content/mediaAutoplay` › Permitir › adicione o site.
  - **Firefox:** cadeado na barra de endereço › Permissões › Reprodução automática ›
    Permitir áudio e vídeo.
  - Num computador só de atendimento, também dá para abrir o Chrome com
    `--autoplay-policy=no-user-gesture-required`.

## Mensagens e webhook

As mensagens usam o mesmo socket do WhatsApp das ligações (o WhatsApp aceita uma conexão por
aparelho vinculado). Só conversas individuais: grupos, status e canais são ignorados.

- `type`: `text`, `image`, `video`, `audio`, `document`, `sticker` (webp) ou `location`
  (`latitude`, `longitude`, `name?`, `address?`). Sem `type`, a mídia é deduzida pelo mimetype.
- **Áudio** sai como **áudio de voz** (convertido para ogg/opus com o ffmpeg). Use `"ptt": false`
  para enviar como arquivo de áudio.
- Mídia por `url` (o gateway baixa) ou `base64` (aceita `data:...;base64,`), até 25 MB.
- O número segue a mesma regra das ligações: DDI+DDD+número, testando com e sem o 9º dígito.

**No painel**, a aba **Mensagens** de cada telefone é um chat no estilo do WhatsApp: conversas com
não lidas, fotos, vídeos, figurinhas, documentos, localização, contatos, áudio de voz (ouvir e
gravar pelo microfone), respostas, reações e confirmação de leitura (✓✓ azul). Ela aparece para quem
tem a permissão **Mensagens**. A pesquisa acha conversas e contatos da agenda do celular por nome
ou número, como no WhatsApp Web. Mensagens antigas: no topo de cada conversa, **Buscar mensagens mais
antigas no celular**; para todas, Configurações › **Sincronizar tudo**.

**Webhook** (Configurações da linha › Webhook): o gateway faz um `POST` JSON para a sua URL a
cada evento:

```json
{"id":"uuid","event":"message.received","timestamp":"…","line":{"id":"…","name":"…","phone":"55…"},
 "data":{"id":"3EB0…","direction":"incoming","remote":"5511999999999","pushName":"Maria","type":"audio",
         "media":{"mimetype":"audio/ogg; codecs=opus","seconds":7,"ptt":true},
         "mediaUrl":"https://SEU_GATEWAY/api/v1/messages/3EB0…/media","status":"delivered","timestamp":"…"}}
```

- Eventos: `message.received`, `message.sent` (pela API, pelo painel ou pelo celular),
  `message.status` (`sent` → `delivered` → `read` → `played`), `message.updated`, `message.deleted`,
  `conversation.updated`, `call.incoming`, `call.dialing`, `call.answered`, `call.connected`,
  `call.ended`, `call.busy`, `call.recording`, `call.transcript` e `line.status`. Dá para escolher quais.
- Assinatura: `X-Webhook-Signature: sha256=<HMAC-SHA256(segredo, X-Webhook-Timestamp + "." + corpo)>`
  em hex. Confira antes de confiar no evento.
- Responda 2xx em até 10 s. Se não responder, o envio é repetido após 5 s, 30 s e 2 min, mantendo a
  ordem dos eventos de cada linha. A fila fica no banco (sobrevive a reinícios); as entregas que
  falharam aparecem em **Configurações › Entregas do webhook**, com botão para reenviar.
- `mediaUrl` usa a variável `PUBLIC_URL` e exige o token da linha (`Authorization: Bearer`).

## Área de atendimento (`/atendimento`)

A tela do dia a dia de quem atende: **uma caixa de entrada com as conversas de todos os números**
que a pessoa acessa (com filtro por número e a etiqueta do número em cada conversa) e um **telefone
flutuante** que toca quando chega ligação em qualquer um deles. O **Ligar** deixa escolher o número de
saída. Quem só atende entra direto aqui ao fazer login, sem ver QR, token ou configurações.

**Quais números cada um acessa** é definido em **Usuários e grupos › grupo**: marque os números do
grupo e escolha o perfil em cada um:

| Perfil | Pode |
|---|---|
| Atendente | mensagens + receber e fazer ligações |
| Só mensagens | só o chat |
| Só ligações / Só receber ligações | só o telefone |
| Supervisor | atendente + conectar o número (QR); usa também o painel |
| Gerente | tudo no número, inclusive configurações e integrações |

Use **Personalizar** para combinar permissões e **Todos os números / Perfil para todos** para grupos
grandes. Uma pessoa em vários grupos soma os acessos.

## Atendimento no painel

- **Mensagens** (aba de cada telefone): chat no estilo do WhatsApp, com responsável por conversa
  (**Assumir**), situação (aberta / aguardando cliente / resolvida, reabre quando o cliente escreve),
  filtros (Abertas, Minhas, Sem responsável, Resolvidas), nome e notas internas do contato, e as
  ligações na mesma linha do tempo das mensagens.
- **Respostas rápidas:** digite `/` no chat. Cadastre em Configurações (`{nome}` e `{atendente}`
  viram o nome do contato e o seu).
- **Horário de atendimento** com resposta automática fora do horário (uma vez a cada 12 h por contato).
- **Grupos** (opcional por telefone), mensagens editadas e apagadas, reações, figurinhas e áudios.
- **Histórico e agenda do celular:** o histórico que o celular envia fica gravado. Em cada
  conversa, **Buscar mensagens mais antigas no celular**; em Configurações, **Sincronizar tudo**
  (todas as conversas até o início, mais a agenda). Num telefone vinculado agora, o celular já envia
  o histórico completo. Conversas que nunca passaram pelo gateway só chegam vinculando de novo.
- **Contatos:** nomes da agenda do celular e do perfil, com pesquisa por nome e número
  (`GET /api/v1/contacts?q=`).
- **Vídeo:** no discador, **Ligar com vídeo** pela **câmera** ou pela **tela do computador**; durante
  qualquer ligação dá para trocar entre Câmera, Tela e Sem vídeo, vendo o vídeo do cliente.
  Chamadas de vídeo recebidas (opção por telefone): atender só com áudio (padrão), mostrando o
  vídeo do cliente ou recusar.
- **Contatos ocultos** (administradores): números cujas mensagens e ligações ficam gravadas, mas não
  aparecem no painel, no atendimento, na API nem no webhook; as ligações deles tocam só no celular.
  Configure em Configurações › Contatos ocultos, ou no chat: Dados do contato › Ocultar este contato.
- **Áudio guardado:** o áudio de toda ligação atendida e todos os áudios das conversas (recebidos e
  enviados) ficam guardados para análise (vídeo não). Avise os contatos, pela LGPD. Veja
  [Transcrição](#transcrição-de-áudio-para-texto).
- **Métricas** (`/admin/metrics`): ligações recebidas, atendidas e perdidas, espera e conversa médias,
  mensagens, por dia, por hora e por atendente.
- **Auditoria** (`/admin/audit`, administradores): logins e alterações, com segredos mascarados.
- **Limite de envio** por telefone (padrão 20 por minuto e 1000 por dia) para proteger o número.

## Produção

### HTTPS

O gateway fala HTTP na porta 3000 e **não cuida de certificado**. Fora do `localhost`, ponha-o atrás
de um proxy reverso com HTTPS (nginx, Caddy, Traefik, Cloudflare Tunnel, o balanceador da sua nuvem…).
A configuração do proxy é por sua conta; o que ele precisa garantir:

**Por que é obrigatório:** os navegadores só liberam **microfone, câmera e compartilhamento de tela**
em páginas HTTPS (ou `localhost`). Sem HTTPS não dá para atender nem ligar pelo painel, pelo
`/atendimento`, pelos iframes ou pelo SDK, nem fazer ligação com vídeo. E o login, os cookies de
sessão, os tokens das linhas e a `ADMIN_API_KEY` trafegariam em texto puro.

**O que precisa estar em HTTPS:**

| O quê | Endereço |
|---|---|
| Painel, `/atendimento`, `/login`, `/docs` | `https://SEU_GATEWAY/…` |
| Iframes (`/embed/receiver`, `/embed/dialer`) e o SDK (`/sdk.js`) | `https://SEU_GATEWAY/…` |
| **O site que incorpora** os iframes ou o SDK | a página-mãe também em HTTPS: numa página HTTP o navegador bloqueia o microfone do iframe |
| WebSockets (eventos, áudio e vídeo das ligações) | `wss://SEU_GATEWAY/api/v1/events`, `/api/v1/media`, `/api/v1/video-up`, `/admin/api/events` |
| API (`/api/v1/*`, `/admin/api/*`) | recomendado (tokens no cabeçalho) |
| A URL do **seu** webhook | recomendado (`https://…`), o corpo leva mensagens e números |

**O que o proxy precisa fazer:**

- Encaminhar tudo para `http://127.0.0.1:3000`, mantendo o `Host` e enviando `X-Forwarded-Proto: https`
  (os links da documentação e o `frame-ancestors` usam) e `X-Forwarded-For` (IP na auditoria).
- **Repassar WebSocket** (`Upgrade` / `Connection: upgrade`) e não derrubar conexões paradas por menos
  de 60 s (o gateway manda `ping` a cada 25 s; uma ligação pode durar horas).
- **Não bufferizar** respostas longas: o vídeo do cliente (`/api/v1/calls/:id/video`) é um fluxo MJPEG
  contínuo e o áudio das gravações usa `Range`.
- Aceitar corpos de até **36 MB** (envio de mídia em base64 até 25 MB).
- Redirecionar `http://` para `https://`.

**No `.env`:**

```bash
PUBLIC_URL=https://voz.suaempresa.com.br   # links de mídia no webhook e da documentação
SECURE_COOKIES=true                        # cookie de sessão só em HTTPS
TRUST_PROXY=true                           # IP real do cliente (X-Forwarded-For)
APP_BIND=127.0.0.1                         # porta 3000 só para o proxy (se ele estiver no mesmo servidor)
```

Depois: `docker compose up -d`. Teste abrindo `https://SEU_GATEWAY/atendimento` e fazendo uma ligação:
o navegador precisa pedir o microfone.

### HTTPS pronto (Caddy): `docker-compose.https.yml`

Se não tiver um proxy, use o compose com Caddy, que já faz tudo da lista acima (certificado,
WebSocket, sem buffer, 36 MB, redirecionamento) e liga `SECURE_COOKIES` e `TRUST_PROXY` sozinho.
Usa os mesmos volumes do `docker-compose.yml`: dá para trocar um pelo outro sem perder dados.

```bash
# .env
DOMAIN=voz.suaempresa.com.br, localhost   # vírgula separa vários endereços
PUBLIC_URL=https://voz.suaempresa.com.br

docker compose -f docker-compose.https.yml up -d --build
```

| Porta | Para quê | Variável |
|---|---|---|
| 80, 443 (tcp/udp) | HTTPS externo (Caddy). 80 só redireciona e valida o Let's Encrypt | `HTTPS_BIND`, `HTTP_PORT`, `HTTPS_PORT` |
| 3000 | dev: app direto em HTTP, sem passar pelo Caddy. Só em `127.0.0.1` por padrão | `DEV_BIND`, `DEV_PORT` |
| 5432 | Postgres em `127.0.0.1` (Prisma Studio, app fora do Docker) | `POSTGRES_PORT` |

- **Domínio público:** aponte o DNS para o servidor e libere 80 e 443 no firewall; o Caddy pega o
  certificado do Let's Encrypt sozinho.
- **Dev / rede local:** `DOMAIN=localhost, 192.168.0.10` (IP da sua máquina). O Caddy emite um
  certificado da CA interna dele; o navegador avisa uma vez e depois libera o microfone, inclusive
  no celular. Para não ter aviso, instale a CA:
  `docker compose -f docker-compose.https.yml cp caddy:/data/caddy/pki/authorities/local/root.crt .`
- `http://localhost:3000` (porta de dev) também libera o microfone, por ser `localhost`.

**Backup** do banco e das sessões do WhatsApp (guarda em `./backups`, apaga os de mais de 14 dias):

```bash
./scripts/backup.sh                      # agora
0 3 * * * cd /caminho && ./scripts/backup.sh >> backups/backup.log 2>&1   # crontab, todo dia às 3h
./scripts/restore.sh 20261004-030000     # restaurar (para o app, substitui banco e sessões)
```

**Atualização automática** quando o código muda. O `scripts/deploy.sh` compila o baileys-caller
se o `src/` dele mudou, reconstrói a imagem e recria o app. Só reinicia o app se algo mudou
de fato e volta para a imagem anterior se a nova não ficar saudável. O log fica em `logs/deploy.log`,
e as falhas também vão para `ALERT_WEBHOOK_URL`. Para disparar a cada commit, pull, rebase ou troca de
branch, instale o hook:

```bash
for h in post-commit post-merge post-checkout post-rewrite; do
  ln -sf "$PWD/scripts/hooks/baileys-caller" ".git/hooks/$h"
done
./scripts/deploy.sh                    # ou rode à mão a qualquer momento
AUTO_DEPLOY=0 git commit ...           # commit sem atualizar o container
```

### Transcrição de áudio para texto

**Desligada por padrão.** Quando ligada, transcreve as ligações e os áudios de voz das conversas, e o
texto aparece junto do áudio no chat, no atendimento e no histórico:

- **Ligações:** separadas por quem falou (cliente / atendente), com o tempo de cada fala. A gravação
  guarda cada lado num canal, só para isso.
- **Áudios de voz:** recebidos e enviados, com o nome de quem mandou.

| `TRANSCRIBE` | Como funciona |
|---|---|
| `off` (padrão) | Desligada. O áudio continua sendo guardado. |
| `local` | **whisper.cpp dentro do próprio container**, sem serviço externo. O modelo é baixado na primeira vez para `DATA_DIR/models` e roda com prioridade baixa, para não atrapalhar as ligações. |
| `api` | API compatível com OpenAI (`/v1/audio/transcriptions`): OpenAI, Groq… (`TRANSCRIBE_API_URL`, `TRANSCRIBE_API_KEY`). |

```bash
# .env: servidor barato (2 vCPU / 2 GB)
TRANSCRIBE=local
TRANSCRIBE_MODEL=small-q5_1          # a lista de modelos está comentada no .env.example
TRANSCRIBE_LANGUAGE=pt
```

Com 4 vCPU, `large-v3-turbo-q5_0` transcreve bem melhor. Uma transcrição roda por vez; as ligações
gravadas com a transcrição desligada não têm os lados separados (o texto sai sem dizer quem falou).
Fora do Docker, instale o `whisper-cli` do [whisper.cpp](https://github.com/ggml-org/whisper.cpp) e
aponte `WHISPER_CLI` para ele se não estiver no `PATH`.

**Operação:**

| Variável | Para quê |
|---|---|
| `ALERT_WEBHOOK_URL` | Alertas (telefone fora do ar por 2 min, processo da linha caindo, webhook falhando) para Slack, Discord ou qualquer URL. |
| `LOG_FORMAT=json` | Logs estruturados, uma linha JSON por evento. |
| `MEDIA_CACHE_DAYS`, `MEDIA_CACHE_MAX_MB` | Limpeza do cache de mídia (padrão 30 dias e 5 GB). |
| `RECORDINGS_DAYS` | Apaga gravações de ligação e áudios das conversas mais antigos (0 = guarda para sempre). |
| `AUDIT_DAYS` | Tempo de guarda da auditoria (padrão 365). |
| `ALLOW_PRIVATE_URLS` | Permite mídia de endereços da rede interna (bloqueado por padrão). |
| `TZ` | Fuso do horário de atendimento, dos limites diários e das métricas. |

Se a conexão com o WhatsApp cair, a linha reinicia e reconecta sozinha (sem novo QR).

## Testes

```bash
npm test                                                           # unidade
TEST_DATABASE_URL=postgresql://usuario:senha@localhost:5432/banco npm test   # + integração
```

A integração sobe o gateway com um WhatsApp simulado num *schema* descartável do banco informado
(criado e apagado a cada execução).

## Bot / IA (`ws-bridge`)

Configure a linha com **Atender automaticamente** + **Ponte WebSocket** e a URL do seu serviço.
Para cada ligação, o gateway abre um WebSocket com ele e troca áudio PCM16 em tempo real.

- **Gateway → serviço:** `{"event":"start",...}`, depois o áudio binário e por fim `{"event":"stop"}`.
- **Serviço → gateway:** áudio binário, mais os comandos `{"event":"clear"}` (*barge-in*),
  `{"event":"mark","name"}`, `{"event":"play","url"}` e `{"event":"hangup"}`.

Há um exemplo em `examples/echo-bridge-server.ts` (`npm run bridge:example`).

## Diagnóstico

`VOIP_DEBUG=1 npm start` mostra a sinalização de chamadas (offer/accept/terminate), as mudanças de
estado e os erros de cada linha. `VOIP_DEBUG=wasm` inclui também os logs internos do motor de voz,
que são muito verbosos.

## Limitações

- **Uma ligação por linha por vez.** Uma ligação que chega com a linha ocupada não é atendida
  (evento `busy`). Para atender várias ao mesmo tempo, crie mais linhas.
- Ligações: 1:1 e sem chamadas em grupo. O vídeo enviado passa por JPEG e pelo codificador do
  WhatsApp sem aceleração: a qualidade é menor que a do WhatsApp Web.
- Mensagens antigas: vêm do celular, que precisa estar com internet. Conversas que nunca passaram pelo
  gateway só chegam vinculando o telefone de novo (o celular envia o histórico a um vínculo novo).
- Use um número dedicado por linha. Ligações feitas pelo celular do mesmo número disputam a conta.
- `data/` (ou o volume `appdata`) contém as sessões do WhatsApp. Trate como credencial, junto com o banco.
