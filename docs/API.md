# API do PhdZap

Referência completa da API: ligações, mensagens, eventos em tempo real, áudio, gestão de
telefones/usuários e a ponte de IA. O webhook tem documento próprio: [WEBHOOK.md](WEBHOOK.md).

- [Conceitos](#conceitos)
- [Autenticação](#autenticação)
- [Convenções](#convenções)
- [Objetos](#objetos)
- [Linha](#linha)
- [Ligações](#ligações)
- [Mensagens](#mensagens)
- [Conversas e contatos](#conversas-e-contatos)
- [Eventos em tempo real (WebSocket)](#eventos-em-tempo-real-websocket)
- [Áudio da ligação (WebSocket de mídia)](#áudio-da-ligação-websocket-de-mídia)
- [Ponte de IA (`ws-bridge`)](#ponte-de-ia-ws-bridge)
- [Iframes e SDK JavaScript](#iframes-e-sdk-javascript)
- [API de gestão](#api-de-gestão)
- [Erros](#erros)
- [Limites](#limites)

---

## Conceitos

| Termo | Significado |
|---|---|
| **Linha** (telefone) | Um número de WhatsApp conectado ao gateway (pelo QR). Cada linha tem um **token** próprio e roda em um processo separado. |
| **Ligação** | Chamada de voz do WhatsApp. **Uma por linha por vez.** |
| **Mensagem** | Mensagem de conversa individual (texto, áudio, mídia…). Grupos, status e canais são ignorados. |
| **Handler** | Quem cuida do áudio de uma ligação atendida: `browser` (atendente pelo navegador/WS de mídia), `ws-bridge` (IA externa), `echo` (teste), `silence`. |
| **clientId** | Identificador que você escolhe para a aba/cliente que vai ficar com a ligação (o primeiro a atender leva). |
| **Número** | Sempre só dígitos, com DDI e DDD: `5581999999999`. Números do Brasil são testados com e sem o 9º dígito. |

URL base: o endereço do gateway, ex. `https://voz.suaempresa.com.br`. Nos exemplos: `$GW` e `$TOKEN`.

```bash
export GW=http://localhost:3000
export TOKEN=wvl_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # token da linha (painel › telefone › Iframes)
```

---

## Autenticação

### API da linha (`/api/v1/*`)

Duas formas:

1. **Token da linha** (integrações, servidores, SDK, iframes):
   ```
   Authorization: Bearer <token da linha>
   ```
   ou `?token=<token>` na URL (necessário em WebSockets do navegador). O token identifica a linha:
   não é preciso informar o id dela.

2. **Sessão do painel** (cookie `wvg_session`, usado pelo próprio painel): informe a linha em
   `?line=<id>` ou no cabeçalho `x-line-id`. Valem as permissões do usuário nos grupos.

O token da linha tem as permissões de atendente: **ver, receber, ligar e mensagens**. Ele não
administra a linha (QR, configurações, token).

**Origem:** se a linha tiver *Sites permitidos* configurados e a requisição vier de um navegador
(cabeçalho `Origin`) de outro site, ela é recusada com `403`. Chamadas de servidor (sem `Origin`) não
são afetadas.

**CORS:** `/api/v1/*` responde com `Access-Control-Allow-Origin: *` (métodos `GET, POST, OPTIONS`;
cabeçalhos `authorization, content-type, x-line-id`).

> Nunca exponha o token em páginas públicas sem *Sites permitidos*. Para regenerar:
> painel › telefone › Iframes › **Gerar novo token** (o antigo para na hora).

### API de gestão (`/admin/api/*`)

- **Chave de acesso** (`ADMIN_API_KEY` do `.env`): `Authorization: Bearer <chave>` — super admin.
- ou a **sessão do painel** (cookie), com as permissões do usuário.

### Permissões

| Permissão | Libera |
|---|---|
| `view` | ver a linha e o histórico de ligações |
| `receive` | atender e recusar ligações |
| `dial` | fazer ligações |
| `messages` | ver e enviar mensagens |
| `connection` | QR, desconectar e reiniciar a linha |
| `settings` | alterar configurações (inclui webhook) |
| `integrations` | ver o token, iframes, SDK e API; gerar novo token |

### Testar no Postman

Baixe a coleção com todas as rotas, já apontando para este gateway:
[**phdzap.postman_collection.json**](http://localhost:3000/docs/postman.json).

1. No Postman: **Import** › arraste o arquivo.
2. Na coleção, aba **Variables**, preencha `lineToken` (token da linha), `adminKey` (`ADMIN_API_KEY`)
   e `numero` (contato de teste, com DDI e DDD).
3. As pastas **API da linha** e **API de gestão** já usam o token certo em cada rota. Ids como
   `messageId`, `callId` e `lineId` também são variáveis: copie da resposta de uma listagem.

O mesmo arquivo abre no Insomnia, no Bruno e no Hoppscotch.

---

## Convenções

- Corpo das requisições e respostas em **JSON** (`content-type: application/json`), UTF-8.
- Datas em **ISO 8601 UTC**: `2026-10-03T22:49:16.471Z`.
- Erros: status HTTP + `{"error": "mensagem em português"}` (veja [Erros](#erros)).
- Ids de ligação e de mensagem são os do WhatsApp (strings opacas, ex. `3EB0C4A1F2…`).

---

## Objetos

### Ligação (`Call`)

```json
{
  "id": "C1A2B3D4E5F6",
  "lineId": "1b9431a0",
  "lineName": "Principal",
  "direction": "incoming",
  "remote": "5581992338229",
  "remoteJid": "5581992338229@s.whatsapp.net",
  "pushName": "Maria",
  "status": "connected",
  "handler": "browser",
  "startedAt": "2026-10-03T22:40:00.000Z",
  "connectedAt": "2026-10-03T22:40:06.120Z",
  "endedAt": null,
  "endReason": null,
  "ownerAgent": "Ana",
  "ownerUserId": "cmuszidve000dijx5678h5c04"
}
```

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | string | Id da ligação. |
| `lineId`, `lineName` | string | Linha. |
| `direction` | `incoming` \| `outgoing` | Recebida ou feita. |
| `remote` | string | Número do outro lado (dígitos) ou o JID quando o número não é conhecido. |
| `remoteJid` | string? | JID do WhatsApp. |
| `pushName` | string? | Nome do perfil do contato (recebidas). |
| `isVideo` | boolean? | Chamada de vídeo recebida. |
| `videoStream` | boolean? | O vídeo do cliente pode ser visto em [`GET /api/v1/calls/:id/video`](#get-apiv1callsidvideo--vídeo-do-cliente). |
| `status` | `ringing` \| `connected` \| `ended` | Situação. |
| `handler` | string? | Quem cuida do áudio. |
| `startedAt` / `connectedAt` / `endedAt` | data? | Início, atendimento e fim. |
| `endReason` | string? | `hangup` (desligada por aqui ou duração máxima), `remote_end` (o outro lado desligou), `rejected` (recusada), `ended`, `disconnect` (linha desconectou), `line_restart` (a linha reiniciou). |
| `ownerAgent` | string? | Nome de quem atendeu/ligou. |
| `ownerUserId` | string? | Usuário do painel que ficou com a ligação. |
| `ownerClientId` | string? | `clientId` que ficou com a ligação (só na API/WS, não no webhook). |
| `hasRecording` | boolean? | Há gravação: [`GET /api/v1/calls/:id/recording`](#get-apiv1callsidrecording--gravação). |
| `recordingSeconds` | number? | Duração da gravação. |
| `transcript` | string? | Transcrição automática da gravação (`Cliente: …` / `Atendente: …`, uma fala por linha). |
| `transcriptSegments` | array? | A mesma transcrição por fala: `[{ "at": 3.2, "who": "contact" \| "agent", "text": "…" }]` (`at` em segundos). |

### Mensagem (`Message`)

```json
{
  "id": "3EB0A1B2C3D4E5F6",
  "lineId": "1b9431a0",
  "direction": "incoming",
  "remote": "5581992338229",
  "remoteJid": "5581992338229@s.whatsapp.net",
  "pushName": "Maria",
  "type": "audio",
  "text": null,
  "media": { "mimetype": "audio/ogg; codecs=opus", "size": 20480, "seconds": 7, "ptt": true },
  "replyTo": "3EB0FFEE…",
  "status": "delivered",
  "agent": null,
  "timestamp": "2026-10-03T22:49:16.000Z",
  "mediaUrl": "https://voz.suaempresa.com.br/api/v1/messages/3EB0A1B2C3D4E5F6/media"
}
```

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | string | Id da mensagem no WhatsApp (único por linha). |
| `direction` | `incoming` \| `outgoing` | Recebida, ou enviada (pela API, pelo painel **ou pelo celular**). |
| `remote` | string | Número do contato (dígitos). Quando o WhatsApp só informa o LID e não há como achar o número, vem o JID (`…@lid`). |
| `remoteJid` | string | JID da conversa (`…@s.whatsapp.net` ou `…@lid`). |
| `pushName` | string? | Nome do perfil do contato (recebidas). |
| `type` | string | `text`, `image`, `video`, `audio`, `document`, `sticker`, `location`, `contact`, `reaction` ou `other`. |
| `text` | string? | Texto; legenda da mídia; emoji da reação (vazio = reação removida); para `other`, o tipo interno do WhatsApp. |
| `media` | objeto? | `mimetype`, `fileName`, `size` (bytes), `seconds` (áudio/vídeo), `ptt` (`true` = áudio de voz). |
| `location` | objeto? | `latitude`, `longitude`, `name`, `address`. |
| `contact` | objeto? | `name`, `vcard`. |
| `replyTo` | string? | Id da mensagem respondida (ou, numa reação, da mensagem reagida). |
| `participant` / `participantName` | string? | Grupos: número e nome de quem mandou. |
| `editedAt` | data? | A mensagem foi editada (o `text` já é o novo). |
| `deletedAt` | data? | Apagada para todos: o conteúdo some (`text`, `media`). |
| `transcript` | string? | Transcrição automática do áudio de voz (recebido ou enviado; com `TRANSCRIBE` ligado no servidor). |
| `status` | string | Enviadas: `pending` → `sent` → `delivered` → `read` → `played` (áudio ouvido), ou `error`. Recebidas: `delivered` até alguém ler pelo gateway, depois `read`. O status só avança, nunca volta. |
| `agent` | string? | Quem enviou pelo gateway: nome do usuário do painel ou o `agent` informado na API (padrão `API`). Vazio em recebidas e nas enviadas pelo celular. |
| `timestamp` | data | Data da mensagem no WhatsApp. |
| `mediaUrl` | string? | Onde baixar a mídia (exige autenticação). Absoluta se `PUBLIC_URL` estiver definida, senão relativa. |

### Conversa (`Chat`)

```json
{
  "remote": "5581992338229", "remoteJid": "5581992338229@s.whatsapp.net",
  "name": "Maria (VIP)", "teamName": "Maria (VIP)", "phoneName": "Maria Souza", "profileName": "Maria", "isGroup": false,
  "status": "open", "assignedUserId": "cmu…", "assignedName": "Ana Souza", "notes": "Cliente desde 2021",
  "unread": 3, "last": { "…": "Message" }
}
```

| Campo | Descrição |
|---|---|
| `name` | Nome a mostrar: o da equipe (`teamName`), senão o da agenda do celular (`phoneName`), senão o do perfil (`profileName`). Em grupos, o nome do grupo. |
| `teamName` / `phoneName` / `profileName` | Nome dado pela equipe no painel / salvo na agenda do celular / do perfil no WhatsApp. |
| `isGroup` | Conversa de grupo (`remote` é o JID `…@g.us`). |
| `status` | `open` (aberta), `pending` (aguardando o cliente) ou `resolved` (resolvida). Volta para `open` quando o cliente escreve. |
| `assignedUserId` / `assignedName` | Responsável pela conversa. |
| `notes` | Notas internas (o contato não vê). |
| `unread` | Recebidas ainda não lidas pelo gateway. |
| `last` | Mensagem mais recente (reações não contam). |

### Linha pública (`Line`)

```json
{ "id": "1b9431a0", "name": "Principal", "status": "open", "phone": "558599498090", "current": null, "permissions": ["view","receive","dial","messages"] }
```

`status`: `open` (conectada), `qr` (aguardando leitura do QR), `connecting`, `error`, `stopped`.
`current`: ligação em andamento ou `null`.

---

## Linha

### `GET /api/v1/line`

Estado da linha. Permissão: qualquer.

```bash
curl $GW/api/v1/line -H "Authorization: Bearer $TOKEN"
```

Resposta `200`: objeto [`Line`](#linha-pública-line).

---

## Ligações

### `GET /api/v1/calls`

Ligação atual e as 100 últimas encerradas. Permissão: `view`. Com `?contact=<número>`, só as
ligações com aquele contato.

```json
{ "current": { "…": "Call" }, "history": [ { "…": "Call" } ] }
```

### `POST /api/v1/calls` — ligar

Permissão: `dial`.

| Campo | Tipo | Descrição |
|---|---|---|
| `to` | string \| number | **Obrigatório.** Número com DDI e DDD. |
| `handler` | string | `browser`, `ws-bridge`, `echo` ou `silence`. Padrão: `browser` se houver `clientId`, senão o bot configurado na linha. |
| `clientId` | string | A ligação já nasce sua: abra o [WebSocket de mídia](#áudio-da-ligação-websocket-de-mídia) com o mesmo `clientId` para falar. |
| `agent` | string | Nome de quem liga (até 60). Usuários do painel usam o próprio nome. |
| `video` | boolean | Ligação de vídeo. O vídeo enviado sai do [WebSocket de vídeo](#vídeo-do-atendente-websocket) (câmera ou tela); o do cliente, de [`GET /api/v1/calls/:id/video`](#get-apiv1callsidvideo--vídeo-do-cliente). |

```bash
curl -X POST $GW/api/v1/calls -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -d '{"to":"5581992338229","handler":"ws-bridge"}'
```

Resposta `201`: [`Call`](#ligação-call) com `status: "ringing"`. Erros: `409` linha ocupada ou número
não encontrado no WhatsApp, `503` linha desconectada.

### `GET /api/v1/calls/:id/recording` — gravação

Arquivo `audio/ogg` (opus, mono) da ligação, com suporte a `Range`. Permissão: `view`. Toda ligação
atendida é gravada (só o áudio); `404` se não houver gravação.

### `GET /api/v1/calls/:id/video` — vídeo do cliente

Em ligações de vídeo feitas com `"video": true`, nas que o atendente ligou a câmera ou a tela, e
nas chamadas de vídeo recebidas com o telefone configurado para **mostrar o vídeo do cliente**
(`videoCalls: "video"`), devolve o vídeo do cliente como MJPEG
(`multipart/x-mixed-replace`), até 10 quadros por segundo. Ponha a URL num `<img>`; o fluxo
fecha quando a ligação acaba. Permissão: quem está na ligação ou `receive`. Com o token da linha,
use `?token=`.

```html
<img src="https://GATEWAY/api/v1/calls/CALL_ID/video?token=TOKEN">
```

`404` se a ligação não tiver vídeo para mostrar ou já tiver acabado.

### `POST /api/v1/calls/:id/accept` — atender

Permissão: `receive`. **O primeiro a atender leva**; os demais recebem `409`.

| Campo | Tipo | Descrição |
|---|---|---|
| `clientId` | string | Seu cliente. Com ele, o handler padrão é `browser` (áudio pelo WS de mídia). |
| `handler` | string | Ex.: `ws-bridge` para entregar à IA. |
| `agent` | string | Nome de quem atende. |

Resposta `200`: [`Call`](#ligação-call).

### Ações durante a ligação

`POST /api/v1/calls/:id/<ação>` — resposta `200 {"ok":true}`.

| Ação | Corpo | Permissão | Efeito |
|---|---|---|---|
| `reject` | — | `receive` | Recusa a ligação que está tocando (para todos). |
| `hangup` | — | dono da ligação ou `receive`/`dial` | Desliga. |
| `mute` | `{"muted": true}` | idem | Silencia o seu áudio. |
| `play` | `{"url": "https://…/aviso.mp3"}` | idem | Toca um arquivo/URL (qualquer formato do ffmpeg). |
| `clear` | — | idem | Corta o áudio que está tocando. |
| `video-source` | `{"source": "camera"}` | idem | Vídeo enviado: `camera`, `screen` (tela do computador) ou `off`. Numa ligação de voz, liga o vídeo. Responde a ligação (`videoSource`). |

---

## Mensagens

Permissão: `messages` em todas as rotas.

### `POST /api/v1/messages` — enviar

Campos comuns:

| Campo | Tipo | Descrição |
|---|---|---|
| `to` | string \| number | **Obrigatório.** Número com DDI e DDD (testa com e sem o 9º dígito) ou um JID `…@s.whatsapp.net` / `…@lid` / `…@g.us` (grupos, se ligados na linha). |
| `type` | string | `text` (padrão quando há só `text`), `image`, `video`, `audio`, `document`, `sticker`, `location` ou `reaction`. Com `url`/`base64` e sem `type`, o tipo vem do mimetype. |
| `replyTo` | string | Id de uma mensagem **desta linha** para responder citando. Obrigatório em `reaction`. |
| `agent` | string | Nome de quem envia (até 60). Padrão `API`. Usuários do painel usam o próprio nome. |

#### Texto

```json
{ "to": "5581992338229", "text": "Olá! Seu pedido *#4521* saiu para entrega 🚚" }
```

Formatação do WhatsApp: `*negrito*`, `_itálico_`, `~riscado~`, ` ```mono``` `. Até 65.536 caracteres.

#### Mídia

| Campo | Descrição |
|---|---|
| `url` | Endereço `http(s)` do arquivo. O gateway baixa (até 25 MB, 30 s). |
| `base64` | Conteúdo em base64, com ou sem prefixo `data:<mime>;base64,`. Use **ou** `url` **ou** `base64`. |
| `mimetype` | Opcional: vem do `data:`, do `content-type` da URL ou da extensão. |
| `fileName` | Nome do arquivo (documentos). Com `url`, o padrão é o nome no endereço. |
| `caption` | Legenda (imagem, vídeo, documento). `text` também serve. |
| `ptt` | Só áudio. Padrão `true`: **áudio de voz**, convertido para ogg/opus mono 48 kHz, com a duração correta. `false` envia como arquivo de áudio. |

```bash
# Áudio de voz a partir de um mp3
curl -X POST $GW/api/v1/messages -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"to":"5581992338229","type":"audio","url":"https://exemplo.com/recado.mp3"}'

# Imagem com legenda
curl -X POST $GW/api/v1/messages -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"to":"5581992338229","type":"image","url":"https://exemplo.com/produto.jpg","caption":"Chegou!"}'

# Documento em base64
curl -X POST $GW/api/v1/messages -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"to\":\"5581992338229\",\"type\":\"document\",\"fileName\":\"boleto.pdf\",\"base64\":\"$(base64 -w0 boleto.pdf)\"}"
```

- `sticker` precisa ser `image/webp` (512×512 recomendado).
- Vídeo: prefira `video/mp4` (H.264 + AAC).

#### Localização

```json
{ "to": "5581992338229", "type": "location", "latitude": -8.0476, "longitude": -34.877, "name": "Loja Centro", "address": "Rua da Aurora, 100" }
```

#### Reação

```json
{ "to": "5581992338229", "type": "reaction", "replyTo": "3EB0A1B2C3D4E5F6", "text": "👍" }
```

`text` vazio (`""`) remove a sua reação.

**Resposta `201`:** a [`Message`](#mensagem-message) enviada (`direction: "outgoing"`, `status: "sent"`).
Depois chegam as mudanças de status (`delivered`, `read`…) pelo WebSocket e pelo webhook.

Erros comuns: `400` corpo inválido / mídia não baixou / áudio não converteu / URL interna, `404`
`replyTo` não encontrado, `409` número não está no WhatsApp, `413` arquivo grande demais, `429`
limite de envio da linha atingido, `503` linha desconectada.

> **URLs de mídia** precisam ser públicas: endereços internos (localhost, rede privada, metadados de
> nuvem) são recusados, inclusive depois de redirecionamentos. Para liberar num ambiente fechado,
> use `ALLOW_PRIVATE_URLS=true` no gateway.

### `GET /api/v1/messages` — histórico

| Parâmetro | Descrição |
|---|---|
| `contact` | Número do contato (só dígitos). Sem ele, todas as conversas da linha. |
| `limit` | 1 a 500 (padrão 50). |
| `before` | Data ISO: só mensagens anteriores (paginação — use o `timestamp` da mais antiga recebida). |

Ordem: **mais recentes primeiro**. Inclui reações (`type: "reaction"`).

```bash
curl "$GW/api/v1/messages?contact=5581992338229&limit=50" -H "Authorization: Bearer $TOKEN"
```

> O gateway guarda o que chega depois de vinculado e o **histórico que o celular envia**: ao
> vincular, o celular manda as conversas recentes (ou todas, num vínculo novo); mensagens mais
> antigas de uma conversa vêm com [`POST /api/v1/chats/:numero/sync`](#post-apiv1chatsnumerosync--buscar-mensagens-antigas-no-celular).

### `GET /api/v1/messages/:id/media` — baixar a mídia

Devolve o arquivo com o `content-type` original. Imagens (jpeg/png/gif/webp), áudio e vídeo vêm
`inline`; outros tipos vêm como anexo (`attachment`). A primeira leitura busca no WhatsApp e guarda
em cache no servidor.

```bash
curl $GW/api/v1/messages/3EB0A1B2C3D4E5F6/media -H "Authorization: Bearer $TOKEN" -o arquivo
```

Erros: `404` mensagem sem mídia ou inexistente; `409` mídia expirada no WhatsApp (mensagens muito
antigas, que ainda não estavam no cache).

### `POST /api/v1/messages/:id/read` — marcar como lida

Marca a mensagem recebida **e as anteriores da mesma conversa** como lidas, no gateway e no
WhatsApp (o contato vê os ✓✓ azuis). Resposta `200 {"ok":true}`.

---

## Conversas e contatos

Permissão: `messages`.

### `GET /api/v1/chats`

Lista de [`Chat`](#conversa-chat), da conversa mais recente para a mais antiga.

### `POST /api/v1/chats/:numero/sync` — buscar mensagens antigas no celular

Pede ao celular até 50 mensagens anteriores à mais antiga que o gateway tem da conversa. Resposta
`202 {"requested":true}` na hora; as mensagens chegam em seguida (alguns segundos, se o celular
estiver com internet), entram no histórico (`GET /api/v1/messages`) como lidas e geram o evento
`history` no WebSocket. Chame de novo para ir mais para trás. Para todas as conversas de uma vez,
use a [sincronização completa](#histórico-e-agenda-do-celular).

Erros: `409` a conversa ainda não tem nenhuma mensagem no gateway (falta a referência), `503`
linha desconectada.

### `GET /api/v1/contacts` — pesquisar contatos

Agenda do telefone, como na pesquisa do WhatsApp Web: contatos salvos no celular, quem já mandou
mensagem e os nomes dados pela equipe.

| Parâmetro | Descrição |
|---|---|
| `q` | Parte do nome (equipe, agenda ou perfil; sem diferenciar maiúsculas) ou do número. Vazio = todos. |
| `limit` | 1 a 500 (padrão 50). |

```bash
curl "$GW/api/v1/contacts?q=maria" -H "Authorization: Bearer $TOKEN"
```

```json
[{ "remote": "5581992338229", "remoteJid": "5581992338229@s.whatsapp.net", "name": "Maria Souza",
   "phoneName": "Maria Souza", "pushName": "Mari", "hasChat": true }]
```

Contatos com conversa (`hasChat`) vêm primeiro. Para conversar com um contato sem conversa, envie
uma mensagem para o `remote` dele.

### `POST /api/v1/chats/:numero/read`

Marca toda a conversa como lida. Resposta `200 {"ok":true}`.

### `GET /api/v1/contacts/:numero`

Dados de atendimento da conversa e as 20 últimas ligações com o contato:

```json
{ "remote": "5581992338229", "name": "Maria (VIP)", "notes": "…", "status": "open",
  "assignedUserId": "cmu…", "assignedName": "Ana Souza", "updatedAt": "…", "calls": [ { "…": "Call" } ] }
```

### `PATCH /api/v1/contacts/:numero`

Altera o atendimento. Todos os campos são opcionais:

| Campo | Descrição |
|---|---|
| `name` | Nome na equipe (`null` volta a usar o do perfil). |
| `notes` | Notas internas (até 10.000 caracteres). |
| `status` | `open`, `pending` ou `resolved`. |
| `assignedUserId` | Id de um usuário com permissão `messages` na linha, `"me"` (usuário logado no painel) ou `null`. |

Gera o evento `contact` (WebSocket) e `conversation.updated` (webhook).

### `GET /api/v1/agents`

Usuários que podem atender as mensagens da linha: `[{ "id", "name" }]`.

### `GET /api/v1/quick-replies`

Respostas rápidas da linha e as globais: `[{ "id", "shortcut", "text", "global" }]`. No texto,
`{nome}` e `{atendente}` são trocados pelo painel na hora de usar.

### `GET /api/v1/contacts/:numero/photo`

Foto de perfil do contato: `302` para a imagem (URL temporária do WhatsApp) ou `204` sem foto
(ou foto privada). Opcional: `?jid=` para contatos que só têm LID. Cache de 6 h.

---

## Eventos em tempo real (WebSocket)

```
wss://GATEWAY/api/v1/events?token=<token da linha>
```

Mensagens JSON (texto). O servidor envia `ping` a cada 25 s; reconecte se a conexão cair.

| `type` | Campos | Quando |
|---|---|---|
| `hello` | `line` | Ao conectar: estado da linha (com `permissions`). |
| `line` | `line` | Status da linha mudou (conectou, caiu, QR) ou a linha foi reconfigurada. |
| `incoming` | `lineId`, `call` | Ligação chegando (toca em todos). |
| `dialing` | `lineId`, `call` | Ligação de saída iniciada. |
| `answered` | `lineId`, `call` | Alguém ficou com a ligação (`call.ownerAgent`, `call.ownerClientId`). |
| `connected` | `lineId`, `call` | Em conversa. |
| `ended` | `lineId`, `call` | Encerrada (`call.endReason`). |
| `busy` | `lineId`, `from` | Ligaram com a linha ocupada (não atendida). |
| `message` | `lineId`, `message` | Mensagem recebida ou enviada (qualquer origem). Exige `messages`. |
| `message-status` | `lineId`, `message` | Status de uma mensagem enviada avançou. Exige `messages`. |
| `chat-read` | `lineId`, `remote` | Conversa marcada como lida por alguém. Exige `messages`. |
| `message-update` | `lineId`, `message` | Mensagem editada, apagada ou transcrita. Exige `messages`. |
| `contact` | `lineId`, `contact` | Atendimento da conversa mudou (situação, responsável, nome, notas). Exige `messages`. |
| `call-update` | `lineId`, `kind`, `call` | Gravação (`kind: "recording"`) ou transcrição (`"transcript"`) da ligação pronta. |
| `history` | `lineId`, `remotes`, `added`, `syncType` | Chegaram mensagens antigas do celular nessas conversas (recarregue o histórico delas). Exige `messages`. |
| `sync` | `lineId`, `sync` | Andamento da [sincronização completa](#histórico-e-agenda-do-celular). Exige `messages`. |

Contatos ocultos não geram eventos.

Códigos de fechamento: `4001` linha removida ou token alterado; `4002` permissões alteradas
(reconecte).

```js
const ws = new WebSocket(`wss://voz.suaempresa.com.br/api/v1/events?token=${TOKEN}`);
ws.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === "incoming") console.log("Ligação de", ev.call.pushName ?? ev.call.remote);
  if (ev.type === "message" && ev.message.direction === "incoming") console.log("Mensagem:", ev.message.text);
};
```

---

## Vídeo do atendente (WebSocket)

```
wss://GATEWAY/api/v1/video-up?call=<id>&clientId=<seu clientId>&token=<token>
```

Só o dono da ligação (o `clientId` que ligou ou atendeu). Envie cada quadro como **JPEG binário**
(até ~12 por segundo; câmera até 640 px, tela até 1280 px de largura). O gateway converte para o
tamanho que o WhatsApp pedir e repete o último quadro se faltar algum. Escolha antes a fonte com a
ação `video-source` (ou ligue com `"video": true`, que começa com a câmera). O WebSocket fecha
quando a ligação acaba.

## Áudio da ligação (WebSocket de mídia)

Para atender/ligar com o seu próprio áudio (softphone, URA, IA no seu servidor):

```
wss://GATEWAY/api/v1/media?token=<token>&call=<id da ligação>&clientId=<seu id>[&agent=Nome]
```

- **Formato nos dois sentidos:** frames **binários**, PCM 16 bits little-endian, **mono, 16 kHz**
  (20 ms = 640 bytes é um bom tamanho de frame).
- Conectar **reserva** a ligação para o seu `clientId` (o primeiro leva). Se outro já pegou, o
  upgrade falha com `409`.
- **Recebida:** abra a mídia e depois `POST /calls/:id/accept` com o **mesmo `clientId`**.
- **Feita:** `POST /calls` com `clientId` e depois abra a mídia.
- A conexão fecha (código `1000`) quando a ligação termina.

---

## Ponte de IA (`ws-bridge`)

Configure a linha com **handler = Ponte WebSocket** e a URL do seu serviço (`ws://` ou `wss://`).
Para cada ligação atendida por ela, o **gateway conecta no seu serviço**:

**Gateway → seu serviço**

| Mensagem | Descrição |
|---|---|
| texto `{"event":"start","callId","direction","from","fromJid","pushName","sampleRate","encoding":"pcm_s16le","channels":1}` | Início. |
| binário | Áudio do contato: PCM16 LE mono na taxa configurada na linha (8, 16, 24 ou 48 kHz). |
| texto `{"event":"mark","name":"…"}` | O áudio enviado até a marca terminou de tocar. |
| texto `{"event":"stop","reason":"…"}` | Fim da ligação. |

**Seu serviço → gateway**

| Mensagem | Descrição |
|---|---|
| binário | Áudio a falar na ligação (mesmo formato). |
| `{"event":"clear"}` | Interrompe a fala (o contato começou a falar — *barge-in*). |
| `{"event":"mark","name":"…"}` | Peça aviso quando o áudio enviado até aqui terminar de tocar. |
| `{"event":"play","url":"…"}` | Toca um arquivo/URL. |
| `{"event":"hangup"}` | Desliga (depois de terminar o que está tocando). |

Se o seu serviço fechar a conexão durante a ligação, o gateway desliga. Exemplo:
`examples/echo-bridge-server.ts` (`npm run bridge:example`).

---

## Iframes e SDK JavaScript

**Iframes** (painel › telefone › Iframes): `/embed/receiver?token=…&agent=Nome` e
`/embed/dialer?token=…&agent=Nome[&number=55…]`. Use `allow="microphone; camera; display-capture; autoplay"` e HTTPS.
Eventos para a página que incorporou (`postMessage`):

```js
window.addEventListener("message", (e) => {
  if (e.data?.source !== "whatsapp-voice-gateway") return;
  // e.data.type: incoming | answered | answered-elsewhere | dialing | connected | ended
  console.log(e.data.type, e.data.call);
});
```

**SDK** (`<script src="https://GATEWAY/sdk.js">`):

```js
const phone = WhatsAppVoice.connect({ token: "TOKEN", agent: "Maria" });
phone.on("incoming", (call) => …);  phone.answer();  phone.dial("5581…");  phone.hangup();
phone.on("message", (msg) => …);    phone.sendMessage("5581…", "Olá!");
phone.sendMessage("5581…", { type: "audio", url: "https://…/recado.mp3" });
phone.messages({ contact: "5581…", limit: 50 });  phone.markRead(msg.id);
```

Lista completa de eventos e métodos: painel › telefone › JavaScript.

---

## API de gestão

Base: `/admin/api`. Autenticação: `Authorization: Bearer <ADMIN_API_KEY>` ou sessão do painel.

### Sessão (login do painel)

| Rota | Corpo | Descrição |
|---|---|---|
| `POST /admin/api/session` | `{"key":"…"}` ou `{"username","password"}` | Cria o cookie `wvg_session` (7 dias). 10 erros em 10 min por IP → `429`. |
| `DELETE /admin/api/session` | — | Sai. |
| `GET /admin/api/me` | — | Quem está logado e a lista de permissões. |

### Telefones (linhas)

| Rota | Permissão | Descrição |
|---|---|---|
| `GET /admin/api/lines` | `view` (filtra) | Linhas visíveis, com campos conforme as permissões (token só com `integrations`, QR só com `connection`, configurações só com `settings`). |
| `POST /admin/api/lines` | admin | Cria. Corpo: `{"name", …configurações}`. |
| `PATCH /admin/api/lines/:id` | `settings` | Altera configurações (tabela abaixo). |
| `DELETE /admin/api/lines/:id` | admin | Desconecta, apaga a linha e invalida o token. |
| `POST /admin/api/lines/:id/rotate-token` | `integrations` | Gera um novo token. |
| `POST /admin/api/lines/:id/logout` | `connection` | Desconecta o WhatsApp (novo QR). |
| `POST /admin/api/lines/:id/restart` | `connection` | Reinicia o processo da linha. |
| `POST /admin/api/lines/:id/webhook-test` | `settings` | Envia um `ping` ao webhook: `{"ok","status","ms","error"}`. |
| `GET /admin/api/calls?line=:id` | `view` | Últimas 200 ligações (todas as linhas visíveis sem `line`). |
| `GET /admin/api/lines/:id/webhook-deliveries?status=&limit=` | `settings` | Entregas do webhook: `{ summary, deliveries }` (`status`: `pending`, `delivered`, `failed`). |
| `POST /admin/api/lines/:id/webhook-deliveries/:entrega/retry` | `settings` | Reenvia uma entrega. |
| `POST /admin/api/lines/:id/webhook-deliveries/retry-failed` | `settings` | Reenvia todas as que falharam: `{ requeued }`. |
| `GET /admin/api/metrics?days=&line=` | `view` | Métricas de atendimento (ligações, espera, conversa, mensagens, por dia/hora/atendente). |

Configurações da linha:

| Campo | Tipo | Descrição |
|---|---|---|
| `name` | string | 1 a 60 caracteres. |
| `inboundMode` | `manual` \| `auto` \| `reject` | Toca nos atendentes / bot atende / recusa. |
| `videoCalls` | `audio` \| `video` \| `reject` | Chamadas de vídeo recebidas: atende só com áudio (padrão) / mostra o vídeo do cliente (a câmera do atendente fica desligada) / recusa. |
| `handler` | `silence` \| `echo` \| `ws-bridge` | Bot das ligações automáticas e das feitas pela API sem handler. |
| `inboundAnswerDelayMs` | 0–60000 | Espera antes do atendimento automático. |
| `maxCallDurationMs` | 0–86400000 | Duração máxima (0 = sem limite). |
| `bridgeUrl` | string | `ws://` ou `wss://` da ponte de IA. |
| `bridgeSampleRate` | 8000–48000 | Taxa de amostragem da ponte. |
| `allowedOrigins` | string[] ou texto | Sites permitidos (`https://site.com`). Vazio = qualquer. |
| `webhookUrl` | string | URL do webhook (`http(s)`). Vazio = desligado. |
| `webhookSecret` | string | Segredo da assinatura (até 200). |
| `webhookEvents` | string[] | Eventos do webhook (vazio = todos). Veja [WEBHOOK.md](WEBHOOK.md). |
| `rateLimitPerMinute` / `rateLimitPerDay` | número | Limite de mensagens enviadas pelo gateway (0 = sem limite). Padrão 20/min e 1000/dia. |
| `businessHoursEnabled` | boolean | Usa o horário de atendimento. |
| `businessHours` | objeto | Por dia da semana (`"0"` = domingo … `"6"` = sábado): `{"1": [["08:00","18:00"]], "0": []}`. Fuso: `TZ` do servidor. |
| `offHoursMessage` | string | Resposta automática fora do horário (uma vez a cada 12 h por contato; `{nome}` = primeiro nome). |
| `groupsEnabled` | boolean | Recebe e envia mensagens de grupos. |

```bash
curl -X PATCH $GW/admin/api/lines/1b9431a0 -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"webhookUrl":"https://meusistema.com/whatsapp","webhookSecret":"whs_…","webhookEvents":["message.received","call.ended"]}'
```

### Histórico e agenda do celular

| Rota | Permissão | Descrição |
|---|---|---|
| `POST /admin/api/lines/:id/sync-history` | `settings` | Inicia a sincronização completa em segundo plano: baixa de novo a agenda do celular e, conversa por conversa, pede as mensagens antigas (50 por vez) até o início. Resposta `202` com o andamento; `409` se já estiver rodando. |
| `GET /admin/api/lines/:id/sync-history` | `settings` | Andamento: `{ running, startedAt, finishedAt, chats, done, added, contacts, error? }`. |

O celular precisa estar ligado e com internet. Conversas que nunca passaram pelo gateway não têm
referência para pedir o histórico: elas chegam ao **vincular de novo** o telefone (Desconectar e
ler o QR), quando o celular envia o histórico completo.

### Contatos ocultos (só administradores)

Números cujas mensagens e ligações **continuam gravadas**, mas não aparecem no painel, no
atendimento, na API (`/api/v1/*`) nem no webhook, e não geram eventos. O gateway não atende nem
recusa as ligações deles (tocam só no celular), e a API recusa enviar ou ligar para eles (`403`).
A comparação ignora o 9º dígito.

| Rota | Descrição |
|---|---|
| `PATCH /admin/api/lines/:id` | Campo `hiddenContacts`: lista de números (ou texto, um por linha). Substitui a lista. |
| `POST /admin/api/lines/:id/hidden-contacts` | `{"remote":"5581999999999"}` oculta um número; com `"hidden": false`, mostra de novo. Resposta: `{ hiddenContacts }`. |

`hiddenContacts` só aparece em `GET /admin/api/lines` para administradores.

### Usuários e grupos (só administradores)

| Rota | Corpo |
|---|---|
| `GET /admin/api/users` | — |
| `POST /admin/api/users` | `{"username","name","password","isAdmin?","groupIds?"}` — login: 3–40 caracteres `a-z 0-9 . _ -`; senha ≥ 8. |
| `PATCH /admin/api/users/:id` | qualquer campo acima + `active`. Trocar a senha ou desativar derruba as sessões. |
| `DELETE /admin/api/users/:id` | — |
| `GET /admin/api/groups` | — |
| `POST /admin/api/groups` | `{"name","description?","memberIds?","lines?":[{"lineId","permissions":["view","messages",…]}]}` |
| `PATCH /admin/api/groups/:id` | **`name` obrigatório**; `memberIds`/`lines` substituem a lista quando enviados. |
| `DELETE /admin/api/groups/:id` | — |

### Respostas rápidas

| Rota | Permissão | Corpo |
|---|---|---|
| `GET /admin/api/quick-replies?line=` | `view` | — |
| `POST /admin/api/quick-replies` | `settings` na linha (ou admin, se global) | `{"lineId"?, "shortcut", "text"}` — atalho: letras, números, `_` ou `-` (até 30). Sem `lineId` = vale para todas as linhas. |
| `PATCH /admin/api/quick-replies/:id` | idem | `{"shortcut", "text"}` |
| `DELETE /admin/api/quick-replies/:id` | idem | — |

### Auditoria (só administradores)

`GET /admin/api/audit?limit=&before=&line=&action=&q=` — ações no painel e na API de gestão
(logins, telefones, webhook, usuários, grupos, respostas rápidas), mais recentes primeiro. `action`
filtra por prefixo (`line.`, `user.`…); `q` busca em quem fez e no alvo. Segredos aparecem como `***`.

### Eventos do painel

`wss://GATEWAY/admin/api/events` (cookie da sessão ou `?token=<ADMIN_API_KEY>`): os mesmos eventos
da linha (de todas as linhas visíveis), mais `lines` (lista inicial), `line-admin` (linha atualizada)
e `line-removed`.

---

## Erros

Formato: `{"error": "mensagem"}`.

| Status | Quando |
|---|---|
| `400` | Corpo/parâmetro inválido, mídia que não baixou/converteu. |
| `401` | Sem autenticação ou token inválido. |
| `403` | Sem permissão, ou origem do navegador não permitida para a linha. |
| `404` | Rota, linha, ligação ou mensagem não encontrada. |
| `409` | Conflito ou recusa do WhatsApp: linha ocupada, ligação já atendida por outro, número fora do WhatsApp, mídia expirada. |
| `413` | Corpo ou arquivo grande demais. |
| `429` | Limite de envio de mensagens da linha atingido, ou muitas tentativas de login. |
| `503` | Linha parada ou WhatsApp desconectado. |
| `504` | A linha não respondeu em 45 s. |
| `500` | Erro interno (veja os logs). |

---

## Limites

| Item | Limite |
|---|---|
| Ligações simultâneas | 1 por linha |
| Corpo JSON (geral) | 64 KB |
| Corpo de `POST /messages` | ~35 MB (mídia em base64) |
| Arquivo enviado | 25 MB |
| Texto | 65.536 caracteres; legenda 4.096 |
| Histórico de mensagens por página | 500 |
| Envio de mensagens | por linha, configurável (padrão 20/min e 1000/dia) |
| Conversas | individuais; grupos se `groupsEnabled`; status e canais ignorados |

> **Boas práticas:** o envio de mensagens usa o WhatsApp comum (não a API oficial). Envio em massa
> ou para quem não tem o seu número salvo aumenta o risco de banimento. Respeite intervalos e só
> mande para quem pediu.
