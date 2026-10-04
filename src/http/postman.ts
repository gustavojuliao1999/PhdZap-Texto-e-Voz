/**
 * Coleção do Postman (formato v2.1) com as rotas de docs/API.md, servida em /docs/postman.json.
 * Mantenha em dia com a documentação ao criar ou mudar rotas.
 */

type Req = {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Caminho com variáveis do Postman, ex. `/api/v1/calls/{{callId}}/accept`. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  description?: string;
};
type Folder = { name: string; description?: string; items: Req[] };

const DOCS = "{{baseUrl}}/docs/api";

const LINE_API: Folder[] = [
  {
    name: "Linha",
    items: [{ name: "Estado da linha", method: "GET", path: "/api/v1/line" }],
  },
  {
    name: "Ligações",
    items: [
      { name: "Ligação atual e histórico", method: "GET", path: "/api/v1/calls", query: { contact: "{{numero}}" } },
      { name: "Ligar", method: "POST", path: "/api/v1/calls", body: { to: "{{numero}}", handler: "ws-bridge" },
        description: "`handler`: `browser`, `ws-bridge`, `echo` ou `silence`. Com `clientId`, a ligação já nasce sua." },
      { name: "Gravação", method: "GET", path: "/api/v1/calls/{{callId}}/recording" },
      { name: "Atender", method: "POST", path: "/api/v1/calls/{{callId}}/accept", body: { handler: "ws-bridge", agent: "Postman" } },
      { name: "Recusar", method: "POST", path: "/api/v1/calls/{{callId}}/reject" },
      { name: "Desligar", method: "POST", path: "/api/v1/calls/{{callId}}/hangup" },
      { name: "Silenciar", method: "POST", path: "/api/v1/calls/{{callId}}/mute", body: { muted: true } },
      { name: "Tocar áudio", method: "POST", path: "/api/v1/calls/{{callId}}/play", body: { url: "https://exemplo.com/aviso.mp3" } },
      { name: "Cortar áudio", method: "POST", path: "/api/v1/calls/{{callId}}/clear" },
    ],
  },
  {
    name: "Mensagens",
    items: [
      { name: "Enviar texto", method: "POST", path: "/api/v1/messages",
        body: { to: "{{numero}}", text: "Olá! Seu pedido *#4521* saiu para entrega 🚚" } },
      { name: "Enviar imagem", method: "POST", path: "/api/v1/messages",
        body: { to: "{{numero}}", type: "image", url: "https://exemplo.com/produto.jpg", caption: "Chegou!" } },
      { name: "Enviar áudio de voz", method: "POST", path: "/api/v1/messages",
        body: { to: "{{numero}}", type: "audio", url: "https://exemplo.com/recado.mp3" },
        description: "`ptt: false` envia como arquivo de áudio em vez de áudio de voz." },
      { name: "Enviar documento (base64)", method: "POST", path: "/api/v1/messages",
        body: { to: "{{numero}}", type: "document", fileName: "teste.txt", base64: "data:text/plain;base64,T2zhIQ==" } },
      { name: "Enviar localização", method: "POST", path: "/api/v1/messages",
        body: { to: "{{numero}}", type: "location", latitude: -8.0476, longitude: -34.877, name: "Loja Centro", address: "Rua da Aurora, 100" } },
      { name: "Responder citando", method: "POST", path: "/api/v1/messages",
        body: { to: "{{numero}}", text: "Respondendo esta mensagem", replyTo: "{{messageId}}" } },
      { name: "Reagir", method: "POST", path: "/api/v1/messages",
        body: { to: "{{numero}}", type: "reaction", replyTo: "{{messageId}}", text: "👍" } },
      { name: "Histórico", method: "GET", path: "/api/v1/messages", query: { contact: "{{numero}}", limit: "50" } },
      { name: "Baixar mídia", method: "GET", path: "/api/v1/messages/{{messageId}}/media" },
      { name: "Marcar como lida", method: "POST", path: "/api/v1/messages/{{messageId}}/read" },
    ],
  },
  {
    name: "Conversas e contatos",
    items: [
      { name: "Conversas", method: "GET", path: "/api/v1/chats" },
      { name: "Pesquisar contatos", method: "GET", path: "/api/v1/contacts", query: { q: "maria", limit: "50" },
        description: "Agenda: nome (equipe, agenda do celular ou perfil) ou parte do número." },
      { name: "Buscar mensagens antigas no celular", method: "POST", path: "/api/v1/chats/{{numero}}/sync",
        description: "Pede ao celular até 50 mensagens anteriores à mais antiga da conversa. Depois, veja o Histórico." },
      { name: "Marcar conversa como lida", method: "POST", path: "/api/v1/chats/{{numero}}/read" },
      { name: "Contato (atendimento)", method: "GET", path: "/api/v1/contacts/{{numero}}" },
      { name: "Alterar atendimento", method: "PATCH", path: "/api/v1/contacts/{{numero}}",
        body: { status: "pending", notes: "Cliente pediu retorno amanhã" },
        description: "Campos opcionais: `name`, `notes`, `status` (`open`, `pending`, `resolved`) e `assignedUserId`." },
      { name: "Foto do contato", method: "GET", path: "/api/v1/contacts/{{numero}}/photo" },
      { name: "Atendentes", method: "GET", path: "/api/v1/agents" },
      { name: "Respostas rápidas", method: "GET", path: "/api/v1/quick-replies" },
    ],
  },
];

const ADMIN_API: Folder[] = [
  {
    name: "Sessão",
    items: [
      { name: "Quem sou eu", method: "GET", path: "/admin/api/me" },
      { name: "Login (usuário e senha)", method: "POST", path: "/admin/api/session",
        body: { username: "usuario", password: "senha" }, description: "Cria o cookie `wvg_session`." },
      { name: "Sair", method: "DELETE", path: "/admin/api/session" },
    ],
  },
  {
    name: "Telefones",
    items: [
      { name: "Listar", method: "GET", path: "/admin/api/lines" },
      { name: "Criar", method: "POST", path: "/admin/api/lines", body: { name: "Vendas" } },
      { name: "Alterar configurações", method: "PATCH", path: "/admin/api/lines/{{lineId}}",
        body: { webhookUrl: "https://meusistema.com/whatsapp", webhookEvents: ["message.received", "call.ended"] } },
      { name: "Apagar", method: "DELETE", path: "/admin/api/lines/{{lineId}}" },
      { name: "Gerar novo token", method: "POST", path: "/admin/api/lines/{{lineId}}/rotate-token" },
      { name: "Desconectar (novo QR)", method: "POST", path: "/admin/api/lines/{{lineId}}/logout" },
      { name: "Reiniciar", method: "POST", path: "/admin/api/lines/{{lineId}}/restart" },
      { name: "Testar webhook", method: "POST", path: "/admin/api/lines/{{lineId}}/webhook-test" },
      { name: "Sincronizar histórico e agenda", method: "POST", path: "/admin/api/lines/{{lineId}}/sync-history" },
      { name: "Andamento da sincronização", method: "GET", path: "/admin/api/lines/{{lineId}}/sync-history" },
      { name: "Ocultar contato", method: "POST", path: "/admin/api/lines/{{lineId}}/hidden-contacts", body: { remote: "{{numero}}" },
        description: "Só administradores. Com `\"hidden\": false`, mostra de novo." },
      { name: "Lista de contatos ocultos", method: "PATCH", path: "/admin/api/lines/{{lineId}}", body: { hiddenContacts: ["5581999999999"] },
        description: "Só administradores. Substitui a lista." },
      { name: "Entregas do webhook", method: "GET", path: "/admin/api/lines/{{lineId}}/webhook-deliveries", query: { status: "failed", limit: "50" } },
      { name: "Reenviar entrega", method: "POST", path: "/admin/api/lines/{{lineId}}/webhook-deliveries/{{deliveryId}}/retry" },
      { name: "Reenviar as que falharam", method: "POST", path: "/admin/api/lines/{{lineId}}/webhook-deliveries/retry-failed" },
      { name: "Ligações", method: "GET", path: "/admin/api/calls", query: { line: "{{lineId}}" } },
      { name: "Métricas", method: "GET", path: "/admin/api/metrics", query: { days: "7", line: "{{lineId}}" } },
    ],
  },
  {
    name: "Usuários e grupos",
    items: [
      { name: "Usuários", method: "GET", path: "/admin/api/users" },
      { name: "Criar usuário", method: "POST", path: "/admin/api/users",
        body: { username: "ana", name: "Ana Souza", password: "troque-esta-senha", groupIds: [] } },
      { name: "Alterar usuário", method: "PATCH", path: "/admin/api/users/{{userId}}", body: { active: true } },
      { name: "Apagar usuário", method: "DELETE", path: "/admin/api/users/{{userId}}" },
      { name: "Grupos", method: "GET", path: "/admin/api/groups" },
      { name: "Criar grupo", method: "POST", path: "/admin/api/groups",
        body: { name: "Atendimento Vendas", memberIds: ["{{userId}}"], lines: [{ lineId: "{{lineId}}", permissions: ["view", "receive", "dial", "messages"] }] } },
      { name: "Alterar grupo", method: "PATCH", path: "/admin/api/groups/{{groupId}}", body: { name: "Atendimento Vendas" } },
      { name: "Apagar grupo", method: "DELETE", path: "/admin/api/groups/{{groupId}}" },
    ],
  },
  {
    name: "Respostas rápidas",
    items: [
      { name: "Listar", method: "GET", path: "/admin/api/quick-replies", query: { line: "{{lineId}}" } },
      { name: "Criar", method: "POST", path: "/admin/api/quick-replies",
        body: { lineId: "{{lineId}}", shortcut: "ola", text: "Olá, {nome}! Aqui é {atendente}, como posso ajudar?" } },
      { name: "Alterar", method: "PATCH", path: "/admin/api/quick-replies/{{quickReplyId}}", body: { shortcut: "ola", text: "Olá, {nome}!" } },
      { name: "Apagar", method: "DELETE", path: "/admin/api/quick-replies/{{quickReplyId}}" },
    ],
  },
  {
    name: "Auditoria",
    items: [{ name: "Auditoria", method: "GET", path: "/admin/api/audit", query: { limit: "50" } }],
  },
];

const request = (r: Req) => {
  const segments = r.path.split("/").filter(Boolean);
  const query = Object.entries(r.query ?? {}).map(([key, value]) => ({ key, value }));
  const raw = `{{baseUrl}}${r.path}${query.length ? "?" + query.map((q) => `${q.key}=${q.value}`).join("&") : ""}`;
  return {
    name: r.name,
    request: {
      method: r.method,
      header: r.body === undefined ? [] : [{ key: "Content-Type", value: "application/json" }],
      url: { raw, host: ["{{baseUrl}}"], path: segments, ...(query.length ? { query } : {}) },
      ...(r.body === undefined ? {} : { body: { mode: "raw", raw: JSON.stringify(r.body, null, 2), options: { raw: { language: "json" } } } }),
      ...(r.description ? { description: r.description } : {}),
    },
  };
};

const folder = (f: Folder) => ({ name: f.name, ...(f.description ? { description: f.description } : {}), item: f.items.map(request) });
const bearer = (variable: string) => ({ type: "bearer", bearer: [{ key: "token", value: `{{${variable}}}`, type: "string" }] });

/** Coleção pronta para importar no Postman (ou Insomnia, Bruno, Hoppscotch). */
export const postmanCollection = (origin: string) => ({
  info: {
    name: "PhdZap",
    description:
      `Rotas da API do gateway. Preencha as variáveis da coleção: \`lineToken\` (painel › telefone › Iframes), ` +
      `\`adminKey\` (ADMIN_API_KEY do .env) e \`numero\` (com DDI e DDD). Documentação: ${DOCS}`,
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "baseUrl", value: origin },
    { key: "lineToken", value: "", description: "Token da linha (painel › telefone › Iframes)." },
    { key: "adminKey", value: "", description: "ADMIN_API_KEY do .env." },
    { key: "numero", value: "5581992338229", description: "Número do contato, com DDI e DDD." },
    { key: "messageId", value: "", description: "Id de uma mensagem (veja o Histórico)." },
    { key: "callId", value: "", description: "Id de uma ligação." },
    { key: "lineId", value: "", description: "Id do telefone (veja Telefones › Listar)." },
    { key: "userId", value: "" },
    { key: "groupId", value: "" },
    { key: "quickReplyId", value: "" },
    { key: "deliveryId", value: "" },
  ],
  item: [
    { name: "API da linha", description: "Autenticação: token da linha (`lineToken`).", auth: bearer("lineToken"), item: LINE_API.map(folder) },
    { name: "API de gestão", description: "Autenticação: chave de acesso (`adminKey`).", auth: bearer("adminKey"), item: ADMIN_API.map(folder) },
  ],
});
