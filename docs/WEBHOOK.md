# Webhook do WhatsApp Voice Gateway

O webhook avisa o seu sistema, em tempo real, sobre **mensagens** (recebidas, enviadas, entregues,
lidas), **ligações** (chegando, atendida, encerrada…) e o **status do telefone**. É configurado por
linha (telefone). Para a API, veja [API.md](API.md).

- [Configurar](#configurar)
- [Como a entrega funciona](#como-a-entrega-funciona)
- [Formato da requisição](#formato-da-requisição)
- [Eventos](#eventos)
- [Verificar a assinatura](#verificar-a-assinatura)
- [Baixar a mídia](#baixar-a-mídia)
- [Responder pelo webhook](#responder-pelo-webhook)
- [Exemplos de receptor](#exemplos-de-receptor)
- [Testar](#testar)
- [Problemas comuns](#problemas-comuns)

---

## Configurar

**Pelo painel:** telefone › **Configurações** › **Webhook**:

| Campo | Descrição |
|---|---|
| **URL** | Endereço `http(s)` que recebe os eventos. Vazio = webhook desligado. |
| **Segredo** | Usado para assinar cada envio (HMAC-SHA256). Clique em **Gerar** e guarde o valor no seu sistema. |
| **Eventos** | Quais enviar. Nenhum marcado = **todos**. |

Depois de salvar, use **Testar webhook** (envia um evento `ping`).

**Pela API de gestão:**

```bash
curl -X PATCH $GW/admin/api/lines/<id da linha> \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{
        "webhookUrl": "https://meusistema.com.br/whatsapp/webhook",
        "webhookSecret": "whs_um_segredo_longo_e_aleatorio",
        "webhookEvents": []
      }'

# teste
curl -X POST $GW/admin/api/lines/<id da linha>/webhook-test -H "Authorization: Bearer $ADMIN_API_KEY"
# {"ok":true,"status":200,"ms":42}
```

Defina também **`PUBLIC_URL`** no `.env` do gateway (ex. `https://voz.suaempresa.com.br`) para que
os links de mídia (`mediaUrl`) venham com o endereço completo.

---

## Como a entrega funciona

- **Um `POST` por evento**, com corpo JSON.
- **Sucesso = qualquer resposta `2xx` em até 10 s.** O conteúdo da resposta é ignorado.
- **Novas tentativas:** sem `2xx` (erro, timeout, servidor fora), o mesmo evento é reenviado após
  **5 s, 30 s e 2 min** (4 tentativas no total). Depois disso é descartado e registrado no log do
  gateway.
- **Ordem garantida por linha:** os eventos de uma linha saem um de cada vez, na ordem em que
  aconteceram. Enquanto um evento está sendo retentado, os seguintes esperam.
- **Pelo menos uma vez:** se o seu servidor processar o evento mas demorar mais de 10 s para
  responder, o evento chega de novo. **Use o campo `id` para ignorar repetições** (ele é o mesmo em
  todas as tentativas do mesmo evento).
- **Fila em memória** (até 1.000 eventos por linha): eventos ainda não entregues se perdem se o
  gateway reiniciar. Para reconciliar, consulte `GET /api/v1/messages` e `GET /api/v1/calls`.
- A configuração (URL, segredo, eventos) é lida **na hora de cada envio**: trocar a URL vale para os
  eventos que ainda estão na fila; apagar a URL descarta a fila.

**Recomendação:** responda `200` imediatamente e processe o evento depois (fila/worker no seu lado).

---

## Formato da requisição

```http
POST /whatsapp/webhook HTTP/1.1
Content-Type: application/json
User-Agent: whatsapp-voice-gateway
X-Webhook-Event: message.received
X-Webhook-Timestamp: 1791067756
X-Webhook-Signature: sha256=5d2c1f…e9a0
```

```json
{
  "id": "6f1c2b8e-2a47-4c1e-9b1e-0f6d8a3c5e21",
  "event": "message.received",
  "timestamp": "2026-10-03T22:49:16.512Z",
  "line": { "id": "1b9431a0", "name": "Principal", "phone": "558599498090" },
  "data": { }
}
```

| Campo | Descrição |
|---|---|
| `id` | Id único do evento (UUID). Igual em todas as tentativas — use para deduplicar. |
| `event` | Nome do evento (também no cabeçalho `X-Webhook-Event`). |
| `timestamp` | Quando o evento foi gerado. |
| `line` | Telefone que gerou o evento: `id`, `name` e `phone` (número conectado). |
| `data` | Conteúdo do evento (abaixo). |

| Cabeçalho | Descrição |
|---|---|
| `X-Webhook-Event` | Nome do evento. |
| `X-Webhook-Timestamp` | Unix timestamp (segundos) **desta tentativa**. |
| `X-Webhook-Signature` | `sha256=` + HMAC-SHA256 em hex. Só é enviado se a linha tiver segredo. |

---

## Eventos

| Evento | Quando | `data` |
|---|---|---|
| `message.received` | Chegou mensagem de um contato | [Mensagem](#mensagem) |
| `message.sent` | Mensagem enviada — pela API, pelo painel **ou pelo celular** | [Mensagem](#mensagem) |
| `message.status` | Mensagem enviada mudou de status | [Status](#status-de-mensagem) |
| `call.incoming` | Ligação chegando (tocando) | [Ligação](#ligação) |
| `call.dialing` | Ligação de saída iniciada | [Ligação](#ligação) |
| `call.answered` | Um atendente ficou com a ligação | [Ligação](#ligação) |
| `call.connected` | Conversa começou | [Ligação](#ligação) |
| `call.ended` | Ligação encerrada (atendida ou não) | [Ligação](#ligação) |
| `call.busy` | Ligaram com a linha ocupada (não atendida) | `{ "from": "5581…" }` |
| `line.status` | Telefone conectou, caiu ou pediu QR | [Status da linha](#status-da-linha) |
| `ping` | Botão **Testar webhook** | `{ "message": "Teste do webhook" }` |

`ping` é sempre enviado no teste, mesmo que não esteja na lista de eventos.

### Mensagem

`message.received` e `message.sent`:

```json
{
  "id": "3EB0A1B2C3D4E5F6",
  "lineId": "1b9431a0",
  "direction": "incoming",
  "remote": "5581992338229",
  "remoteJid": "5581992338229@s.whatsapp.net",
  "pushName": "Maria Oliveira",
  "type": "text",
  "text": "Oi! Queria saber do meu pedido",
  "status": "delivered",
  "timestamp": "2026-10-03T22:49:16.000Z"
}
```

| Campo | Descrição |
|---|---|
| `id` | Id da mensagem no WhatsApp. Use em `replyTo` para responder citando. |
| `direction` | `incoming` (recebida) ou `outgoing` (enviada). |
| `remote` | Número do contato (só dígitos, com DDI). Se o WhatsApp só informar o identificador interno (LID) e não houver como achar o número, vem o JID `…@lid`. |
| `remoteJid` | JID da conversa. |
| `pushName` | Nome do perfil do contato (só em recebidas, quando houver). |
| `type` | Veja a tabela abaixo. |
| `text` | Texto, legenda da mídia, ou o emoji da reação. |
| `media` | Em mídias: `mimetype`, `fileName`, `size` (bytes), `seconds`, `ptt` (`true` = áudio de voz). |
| `mediaUrl` | Em mídias: onde baixar o arquivo ([como](#baixar-a-mídia)). |
| `location` | Em localização: `latitude`, `longitude`, `name`, `address`. |
| `contact` | Em contato: `name`, `vcard`. |
| `replyTo` | Id da mensagem respondida; em reações, da mensagem reagida. |
| `status` | Recebida: `delivered`. Enviada: `sent` (ou o status já conhecido). |
| `agent` | Em `message.sent`: quem enviou pelo gateway (usuário do painel ou o `agent` da API). Ausente quando foi enviada pelo celular. |
| `timestamp` | Data da mensagem. |

**Tipos (`type`):**

| `type` | Conteúdo | Exemplo de `data` (campos principais) |
|---|---|---|
| `text` | `text` | `{"type":"text","text":"Oi!"}` |
| `image` | `media`, `mediaUrl`, `text` = legenda | `{"type":"image","text":"Foto do produto","media":{"mimetype":"image/jpeg","size":84211}}` |
| `video` | `media` (`seconds`), `mediaUrl`, legenda | `{"type":"video","media":{"mimetype":"video/mp4","seconds":12}}` |
| `audio` | `media` (`seconds`, `ptt`), `mediaUrl` | `{"type":"audio","media":{"mimetype":"audio/ogg; codecs=opus","seconds":7,"ptt":true}}` |
| `document` | `media` (`fileName`), `mediaUrl`, legenda | `{"type":"document","media":{"mimetype":"application/pdf","fileName":"boleto.pdf","size":51234}}` |
| `sticker` | `media` (`image/webp`), `mediaUrl` | `{"type":"sticker","media":{"mimetype":"image/webp"}}` |
| `location` | `location` | `{"type":"location","location":{"latitude":-8.05,"longitude":-34.88,"name":"Loja"}}` |
| `contact` | `contact` | `{"type":"contact","contact":{"name":"João","vcard":"BEGIN:VCARD…"}}` |
| `reaction` | `text` = emoji (vazio = removida), `replyTo` | `{"type":"reaction","text":"❤️","replyTo":"3EB0…"}` |
| `other` | `text` = tipo interno do WhatsApp (enquete, botões…) | `{"type":"other","text":"pollCreationMessageV3"}` |

Só conversas individuais geram eventos (grupos, status e canais são ignorados). Mensagens apagadas
e editadas não geram eventos.

### Status de mensagem

`message.status` — só para mensagens **enviadas** (`outgoing`):

```json
{ "id": "3EB0A1B2C3D4E5F6", "remote": "5581992338229", "status": "read", "timestamp": "2026-10-03T22:49:16.000Z" }
```

| `status` | Significado |
|---|---|
| `delivered` | Chegou no celular do contato (✓✓). |
| `read` | O contato leu (✓✓ azul). Só chega se o contato não desligou a confirmação de leitura. |
| `played` | O contato ouviu o áudio de voz. |
| `error` | Falhou. |

O status **só avança** (um `delivered` atrasado depois de `read` é ignorado). `timestamp` é a data
da mensagem, não a da mudança de status.

### Ligação

`call.incoming`, `call.dialing`, `call.answered`, `call.connected`, `call.ended`:

```json
{
  "id": "C1A2B3D4E5F6",
  "lineId": "1b9431a0",
  "lineName": "Principal",
  "direction": "incoming",
  "remote": "5581992338229",
  "remoteJid": "5581992338229@s.whatsapp.net",
  "pushName": "Maria Oliveira",
  "status": "ended",
  "handler": "browser",
  "startedAt": "2026-10-03T22:40:00.000Z",
  "connectedAt": "2026-10-03T22:40:06.120Z",
  "endedAt": "2026-10-03T22:44:31.900Z",
  "endReason": "remote_end",
  "ownerAgent": "Ana",
  "ownerUserId": "cmuszidve000dijx5678h5c04"
}
```

| Campo | Descrição |
|---|---|
| `direction` | `incoming` ou `outgoing`. |
| `status` | `ringing`, `connected` ou `ended`. |
| `connectedAt` | Presente se foi atendida. **Duração** = `endedAt − connectedAt`. |
| `endReason` | `remote_end` (o contato desligou), `hangup` (desligada pelo gateway ou pela duração máxima), `rejected` (recusada), `ended`, `disconnect` (o telefone desconectou), `line_restart` (a linha reiniciou). |
| `ownerAgent` / `ownerUserId` | Quem atendeu ou fez a ligação. |
| `handler` | `browser` (atendente), `ws-bridge` (IA), `echo`, `silence`. |

**Ligação perdida** = `call.ended` com `direction: "incoming"` e sem `connectedAt`.

### Status da linha

`line.status`:

```json
{ "status": "open", "previous": "connecting", "phone": "558599498090" }
```

`status`/`previous`: `open` (conectado), `connecting`, `qr` (precisa ler o QR de novo), `error`,
`stopped`. Útil para alertar quando um telefone cai.

---

## Verificar a assinatura

Com segredo configurado, cada requisição traz:

```
X-Webhook-Timestamp: 1791067756
X-Webhook-Signature: sha256=<hex>
```

onde `<hex> = HMAC_SHA256(segredo, X-Webhook-Timestamp + "." + corpo_bruto)`.

Para validar:

1. Leia o **corpo bruto** (os bytes exatamente como chegaram — não re-serialize o JSON).
2. Calcule o HMAC com o segredo da linha e compare com o cabeçalho usando comparação de tempo
   constante.
3. Recuse se `X-Webhook-Timestamp` estiver a mais de **5 minutos** do seu relógio (evita reenvio de
   requisições capturadas).
4. Ignore `id` já processado (deduplicação).

**Node.js (Express)**

```js
import crypto from "node:crypto";
import express from "express";

const SECRET = process.env.WEBHOOK_SECRET;
const app = express();

app.post("/whatsapp/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const ts = req.get("x-webhook-timestamp") ?? "";
  const sig = req.get("x-webhook-signature") ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(`${ts}.${req.body}`).digest("hex");
  const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.sendStatus(401);

  const event = JSON.parse(req.body);
  res.sendStatus(200);          // responda já; processe depois
  queue.push(event);            // sua fila
});
```

**PHP**

```php
<?php
$secret = getenv('WEBHOOK_SECRET');
$body = file_get_contents('php://input');
$ts = $_SERVER['HTTP_X_WEBHOOK_TIMESTAMP'] ?? '';
$sig = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '';
$expected = 'sha256=' . hash_hmac('sha256', $ts . '.' . $body, $secret);

if (!hash_equals($expected, $sig) || abs(time() - (int)$ts) > 300) {
    http_response_code(401);
    exit;
}
$event = json_decode($body, true);
http_response_code(200);
// processe $event['event'] / $event['data']
```

**Python (Flask)**

```python
import hmac, hashlib, os, time
from flask import Flask, request, abort

SECRET = os.environ["WEBHOOK_SECRET"].encode()
app = Flask(__name__)

@app.post("/whatsapp/webhook")
def webhook():
    ts = request.headers.get("X-Webhook-Timestamp", "")
    sig = request.headers.get("X-Webhook-Signature", "")
    body = request.get_data()
    expected = "sha256=" + hmac.new(SECRET, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig) or abs(time.time() - int(ts or 0)) > 300:
        abort(401)
    event = request.get_json()
    # processe event["event"] / event["data"]
    return "", 200
```

---

## Baixar a mídia

Eventos de mídia trazem `mediaUrl`. O download exige o **token da linha**:

```bash
curl -H "Authorization: Bearer $TOKEN" -o arquivo "https://voz.suaempresa.com.br/api/v1/messages/3EB0A1B2C3D4E5F6/media"
```

```js
const res = await fetch(event.data.mediaUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
const bytes = Buffer.from(await res.arrayBuffer());   // content-type = event.data.media.mimetype
```

- Sem `PUBLIC_URL` configurada no gateway, `mediaUrl` vem relativa (`/api/v1/messages/…/media`):
  junte com o endereço do gateway.
- Baixe logo: o WhatsApp mantém a mídia por tempo limitado. Depois do primeiro download ela fica em
  cache no gateway.
- Áudios de voz vêm em `audio/ogg; codecs=opus`.

---

## Responder pelo webhook

Fluxo típico de um bot ou integração:

```js
queue.process(async (ev) => {
  if (ev.event !== "message.received") return;
  const m = ev.data;
  if (m.type === "text" && /boleto/i.test(m.text)) {
    await fetch(`${GW}/api/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        to: m.remote,
        type: "document",
        url: "https://meusistema.com.br/boletos/123.pdf",
        fileName: "boleto.pdf",
        replyTo: m.id,              // responde citando a mensagem
        agent: "Bot",
      }),
    });
    await fetch(`${GW}/api/v1/messages/${m.id}/read`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
  }
});
```

> Cuidado com laços: a sua própria resposta gera `message.sent`. Reaja só a `message.received`.

---

## Exemplos de receptor

**Registrar ligações perdidas:**

```js
if (ev.event === "call.ended" && ev.data.direction === "incoming" && !ev.data.connectedAt) {
  await crm.createTask(`Retornar ligação de ${ev.data.pushName ?? ev.data.remote}`);
}
```

**Tempo de conversa:**

```js
if (ev.event === "call.ended" && ev.data.connectedAt) {
  const secs = (new Date(ev.data.endedAt) - new Date(ev.data.connectedAt)) / 1000;
}
```

**Alerta de telefone desconectado:**

```js
if (ev.event === "line.status" && ev.data.status !== "open") alert(`Telefone ${ev.line.name} caiu: ${ev.data.status}`);
```

---

## Testar

1. Abra um receptor temporário (por exemplo, [webhook.site](https://webhook.site)) e copie a URL.
2. Cole em **Configurações › Webhook**, gere o segredo, salve e clique em **Testar webhook**.
3. Mande uma mensagem para o número da linha e veja o `message.received` chegar.

Para testar localmente (gateway na sua máquina e receptor também), use `http://127.0.0.1:<porta>`.
Com o gateway em Docker, o endereço da sua máquina é o IP do host (no Linux, o gateway da rede do
Docker, ex. `http://172.17.0.1:<porta>`), não `127.0.0.1`.

---

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Teste falha com `fetch failed` / `ECONNREFUSED` | URL inacessível a partir do gateway (firewall, `localhost` dentro do Docker, DNS). |
| Teste falha com timeout | O seu endpoint demora mais de 10 s: responda antes de processar. |
| Assinatura nunca bate | Você está calculando sobre o JSON re-serializado. Use o corpo bruto, e o timestamp do cabeçalho **desta** requisição. |
| Eventos duplicados | Retentativas após timeout. Deduplique pelo `id`. |
| `mediaUrl` sem domínio | Defina `PUBLIC_URL` no `.env` do gateway. |
| Download da mídia retorna `401` | Falta `Authorization: Bearer <token da linha>`. |
| Não chegam mensagens de grupos | Por padrão o gateway só trata conversas individuais. |
| `remote` termina em `@lid` | O WhatsApp não revelou o número do contato; responda usando o mesmo valor em `to`. |
