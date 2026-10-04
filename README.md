# whatsapp-voice-gateway

Central de ligações de voz do WhatsApp sobre o [`baileys-caller`](../baileys-caller):

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

Requisitos: Docker com Compose. A pasta `../baileys-caller` precisa estar ao lado deste projeto,
porque o build a usa como contexto extra.

```bash
cp .env.example .env
# edite o .env: ADMIN_API_KEY (super admin) e POSTGRES_PASSWORD
docker compose up -d --build
```

Abra **http://localhost:3000/**, clique em **Entrar com chave de acesso** e use a `ADMIN_API_KEY`.

- `db`: PostgreSQL 16, com dados no volume `pgdata`.
- `app`: o gateway. As migrações do banco são aplicadas sozinhas ao iniciar. As sessões do WhatsApp
  ficam no volume `appdata` (`/data`). **Não apague esse volume**, senão será preciso ler o QR de novo.
- Logs: `docker compose logs -f app` · diagnóstico de chamadas: `VOIP_DEBUG=1` no `.env`.

## Rodando sem Docker (desenvolvimento)

Requisitos: Node.js ≥ 20, `ffmpeg` no PATH, `../baileys-caller` compilado (`npm run build` lá) e um
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
        allow="microphone; autoplay" style="width:360px;height:420px;border:0"></iframe>

<iframe src="https://SEU_GATEWAY/embed/dialer?token=TOKEN_DA_LINHA&agent=Maria"
        allow="microphone; autoplay" style="width:360px;height:480px;border:0"></iframe>
```

- `agent` é o nome do atendente. Ele aparece para os outros atendentes ("Atendida por Maria") e no histórico.
- `allow="microphone; autoplay"` é obrigatório. Os navegadores só liberam microfone em **HTTPS**
  (ou localhost), então publique o gateway atrás de um proxy HTTPS (Caddy, nginx, Cloudflare Tunnel)
  e use `SECURE_COOKIES=true`.
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
tem a permissão **Mensagens**. Só aparecem as mensagens recebidas ou enviadas depois desta versão:
o histórico antigo do celular não é importado.

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

## Atendimento no painel

- **Mensagens** (aba de cada telefone): chat no estilo do WhatsApp, com responsável por conversa
  (**Assumir**), situação (aberta / aguardando cliente / resolvida, reabre quando o cliente escreve),
  filtros (Abertas, Minhas, Sem responsável, Resolvidas), nome e notas internas do contato, e as
  ligações na mesma linha do tempo das mensagens.
- **Respostas rápidas:** digite `/` no chat. Cadastre em Configurações (`{nome}` e `{atendente}`
  viram o nome do contato e o seu).
- **Horário de atendimento** com resposta automática fora do horário (uma vez a cada 12 h por contato).
- **Grupos** (opcional por telefone), mensagens editadas e apagadas, reações, figurinhas e áudios.
- **Gravação das ligações** (opcional por telefone; avise os contatos, pela LGPD) e **transcrição**
  de ligações e áudios de voz por uma API compatível com OpenAI (`TRANSCRIBE_API_KEY`;
  `TRANSCRIBE_API_URL` aceita Groq ou um whisper local).
- **Métricas** (`/admin/metrics`): ligações recebidas, atendidas e perdidas, espera e conversa médias,
  mensagens, por dia, por hora e por atendente.
- **Auditoria** (`/admin/audit`, administradores): logins e alterações, com segredos mascarados.
- **Limite de envio** por telefone (padrão 20 por minuto e 1000 por dia) para proteger o número.

## Produção

**HTTPS** (Caddy com certificado automático): aponte o DNS do domínio para o servidor, libere as
portas 80/443 e, no `.env`:

```bash
DOMAIN=voz.suaempresa.com.br
PUBLIC_URL=https://voz.suaempresa.com.br
SECURE_COOKIES=true
TRUST_PROXY=true
APP_BIND=127.0.0.1          # a porta 3000 fica só para o Caddy
```

```bash
docker compose --profile https up -d
```

**Backup** do banco e das sessões do WhatsApp (guarda em `./backups`, apaga os de mais de 14 dias):

```bash
./scripts/backup.sh                      # agora
0 3 * * * cd /caminho && ./scripts/backup.sh >> backups/backup.log 2>&1   # crontab, todo dia às 3h
./scripts/restore.sh 20261004-030000     # restaurar (para o app, substitui banco e sessões)
```

**Operação:**

| Variável | Para quê |
|---|---|
| `ALERT_WEBHOOK_URL` | Alertas (telefone fora do ar por 2 min, processo da linha caindo, webhook falhando) para Slack, Discord ou qualquer URL. |
| `LOG_FORMAT=json` | Logs estruturados, uma linha JSON por evento. |
| `MEDIA_CACHE_DAYS`, `MEDIA_CACHE_MAX_MB` | Limpeza do cache de mídia (padrão 30 dias e 5 GB). |
| `RECORDINGS_DAYS` | Apaga gravações mais antigas (0 = guarda para sempre). |
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
- Ligações: só voz 1:1, sem vídeo e sem chamadas em grupo (é uma limitação do WhatsApp num aparelho
  vinculado).
- Mensagens: só as recebidas ou enviadas depois de instalar; o histórico antigo do celular não é importado.
- Use um número dedicado por linha. Ligações feitas pelo celular do mesmo número disputam a conta.
- `data/` (ou o volume `appdata`) contém as sessões do WhatsApp. Trate como credencial, junto com o banco.
