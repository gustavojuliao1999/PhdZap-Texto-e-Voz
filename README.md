# whatsapp-voice-gateway

Central de ligações de voz do WhatsApp sobre o [`baileys-caller`](../baileys-caller):

- **Painel** com login de usuários, **grupos e permissões por telefone**: várias **linhas**
  (telefones), cada uma com QR de pareamento, **token próprio** e configurações.
- **PostgreSQL + Prisma** e **Docker Compose** prontos.
- **Iframes** para colocar em qualquer site:
  - **Receptor**: a ligação toca em todos os atendentes; **o primeiro a atender fica na ligação**.
  - **Discador**: faz ligações pela linha.
- **API REST + WebSocket** por linha (token da linha) e API de gestão (chave de acesso).
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
| Conectar | ler o QR, desconectar e reiniciar o telefone |
| Configurar | alterar as configurações do telefone |
| Integrações | ver o token, os códigos de iframe/SDK e a API, e gerar um novo token |

  Há perfis prontos na tela de grupos: Atendente (ver, receber, ligar), Só receber, Supervisor
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
| WS   | `/api/v1/events?token=` | | `hello`, `incoming`, `dialing`, `answered`, `connected`, `ended`, `busy`, `line` |
| WS   | `/api/v1/media?token=&call=&clientId=` | | áudio PCM16 LE mono 16 kHz nos dois sentidos |

`handler`: `browser` (áudio via `/api/v1/media`), `echo`, `silence`, `ws-bridge` (IA).

Gestão (chave de acesso, `Authorization: Bearer <chave>`): `GET/POST /admin/api/lines`,
`PATCH/DELETE /admin/api/lines/:id`, `POST /admin/api/lines/:id/{logout,restart,rotate-token}`,
`GET /admin/api/calls`.

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
- Só voz 1:1. Sem vídeo e sem grupos.
- Use um número dedicado por linha. Ligações feitas pelo celular do mesmo número disputam a conta.
- `data/` (ou o volume `appdata`) contém as sessões do WhatsApp. Trate como credencial, junto com o banco.
