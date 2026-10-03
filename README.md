# whatsapp-voice-gateway

Central de ligações de voz do WhatsApp sobre o [`baileys-caller`](../baileys-caller):

- **Painel admin** protegido por chave de acesso: várias **linhas** (telefones), cada uma
  com QR de pareamento, **token próprio** e configurações.
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

## Rodando

Requisitos: Node.js ≥ 20, `ffmpeg` no PATH e o `../baileys-caller` compilado (`npm run build` lá).

```bash
npm install
cp .env.example .env
npm start
```

No primeiro start, a **chave de acesso** aparece no terminal (e fica salva em `data/admin.json`),
a menos que você defina `ADMIN_API_KEY` no `.env`. Abra **http://127.0.0.1:3000/**, entre com
a chave, clique em **+ Nova linha** e escaneie o QR no WhatsApp (**Aparelhos conectados**).

> Se você usava a versão anterior (pasta `./auth`), a sessão é migrada automaticamente para uma
> linha chamada "Principal". Pare a versão antiga antes de iniciar esta.

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
- `data/` contém as sessões do WhatsApp e os tokens. Trate como credencial.
