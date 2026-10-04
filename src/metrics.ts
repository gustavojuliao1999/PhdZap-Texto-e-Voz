import { Prisma, type PrismaClient } from "@prisma/client";

/** Fuso das métricas (dias e horas): o mesmo do servidor. */
const tz = (): string => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const n = (v: unknown): number => Number(v ?? 0);

export type Metrics = {
  from: string;
  to: string;
  totals: {
    callsIncoming: number;
    callsAnswered: number;
    callsMissed: number;
    callsOutgoing: number;
    callsOutgoingAnswered: number;
    /** Segundos até atender (recebidas atendidas). */
    avgWaitSeconds: number;
    /** Segundos de conversa (todas as atendidas). */
    avgTalkSeconds: number;
    messagesReceived: number;
    messagesSent: number;
    conversations: Record<string, number>;
  };
  days: { day: string; answered: number; missed: number; outgoing: number; received: number; sent: number }[];
  /** Ligações recebidas por hora do dia (0–23). */
  hours: number[];
  agents: { agent: string; callsAnswered: number; callsMade: number; talkSeconds: number; messagesSent: number }[];
};

/**
 * Indicadores de atendimento das linhas `lineIds` nos últimos `days` dias
 * (dias contados no fuso TZ, incluindo hoje).
 */
export const computeMetrics = async (db: PrismaClient, lineIds: string[], days: number): Promise<Metrics> => {
  const zone = tz();
  const to = new Date();
  const start = new Date(to);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const ids = lineIds.length ? lineIds : ["__nenhuma__"];
  const local = (col: string) => Prisma.raw(`("${col}" AT TIME ZONE 'UTC') AT TIME ZONE '${zone.replace(/'/g, "")}'`);

  const [callTotals] = await db.$queryRaw<any[]>`
    SELECT
      count(*) FILTER (WHERE direction = 'incoming')                                   AS incoming,
      count(*) FILTER (WHERE direction = 'incoming' AND "connectedAt" IS NOT NULL)     AS answered,
      count(*) FILTER (WHERE direction = 'incoming' AND "connectedAt" IS NULL)         AS missed,
      count(*) FILTER (WHERE direction = 'outgoing')                                   AS outgoing,
      count(*) FILTER (WHERE direction = 'outgoing' AND "connectedAt" IS NOT NULL)     AS "outgoingAnswered",
      avg(EXTRACT(EPOCH FROM "connectedAt" - "startedAt")) FILTER (WHERE direction = 'incoming' AND "connectedAt" IS NOT NULL) AS wait,
      avg(EXTRACT(EPOCH FROM "endedAt" - "connectedAt")) FILTER (WHERE "connectedAt" IS NOT NULL AND "endedAt" IS NOT NULL)   AS talk
    FROM "Call" WHERE "lineId" = ANY(${ids}) AND "startedAt" >= ${start}`;

  const [msgTotals] = await db.$queryRaw<any[]>`
    SELECT count(*) FILTER (WHERE direction = 'incoming') AS received,
           count(*) FILTER (WHERE direction = 'outgoing') AS sent
    FROM "Message" WHERE "lineId" = ANY(${ids}) AND "timestamp" >= ${start} AND type <> 'reaction'`;

  const callDays = await db.$queryRaw<any[]>`
    SELECT to_char(${local("startedAt")}, 'YYYY-MM-DD') AS day,
      count(*) FILTER (WHERE direction = 'incoming' AND "connectedAt" IS NOT NULL) AS answered,
      count(*) FILTER (WHERE direction = 'incoming' AND "connectedAt" IS NULL)     AS missed,
      count(*) FILTER (WHERE direction = 'outgoing')                               AS outgoing
    FROM "Call" WHERE "lineId" = ANY(${ids}) AND "startedAt" >= ${start} GROUP BY 1`;

  const msgDays = await db.$queryRaw<any[]>`
    SELECT to_char(${local("timestamp")}, 'YYYY-MM-DD') AS day,
      count(*) FILTER (WHERE direction = 'incoming') AS received,
      count(*) FILTER (WHERE direction = 'outgoing') AS sent
    FROM "Message" WHERE "lineId" = ANY(${ids}) AND "timestamp" >= ${start} AND type <> 'reaction' GROUP BY 1`;

  const hourRows = await db.$queryRaw<any[]>`
    SELECT EXTRACT(HOUR FROM ${local("startedAt")})::int AS hour, count(*) AS calls
    FROM "Call" WHERE "lineId" = ANY(${ids}) AND "startedAt" >= ${start} AND direction = 'incoming' GROUP BY 1`;

  const callAgents = await db.$queryRaw<any[]>`
    SELECT "ownerAgent" AS agent,
      count(*) FILTER (WHERE direction = 'incoming' AND "connectedAt" IS NOT NULL) AS answered,
      count(*) FILTER (WHERE direction = 'outgoing') AS made,
      coalesce(sum(EXTRACT(EPOCH FROM "endedAt" - "connectedAt")) FILTER (WHERE "connectedAt" IS NOT NULL AND "endedAt" IS NOT NULL), 0) AS talk
    FROM "Call" WHERE "lineId" = ANY(${ids}) AND "startedAt" >= ${start} AND "ownerAgent" IS NOT NULL GROUP BY 1`;

  const msgAgents = await db.$queryRaw<any[]>`
    SELECT agent, count(*) AS sent FROM "Message"
    WHERE "lineId" = ANY(${ids}) AND "timestamp" >= ${start} AND direction = 'outgoing' AND agent IS NOT NULL AND type <> 'reaction'
    GROUP BY 1`;

  const conv = await db.contact.groupBy({ by: ["status"], where: { lineId: { in: ids } }, _count: { _all: true } });

  // Série contínua de dias (dias sem nada aparecem com zero).
  const byDay = new Map<string, Metrics["days"][number]>();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const day = fmt.format(d);
    byDay.set(day, { day, answered: 0, missed: 0, outgoing: 0, received: 0, sent: 0 });
  }
  for (const r of callDays) Object.assign(byDay.get(r.day) ?? {}, { answered: n(r.answered), missed: n(r.missed), outgoing: n(r.outgoing) });
  for (const r of msgDays) Object.assign(byDay.get(r.day) ?? {}, { received: n(r.received), sent: n(r.sent) });

  const hours = Array.from({ length: 24 }, () => 0);
  for (const r of hourRows) hours[n(r.hour)] = n(r.calls);

  const agents = new Map<string, Metrics["agents"][number]>();
  const agentOf = (name: string) => {
    let a = agents.get(name);
    if (!a) agents.set(name, (a = { agent: name, callsAnswered: 0, callsMade: 0, talkSeconds: 0, messagesSent: 0 }));
    return a;
  };
  for (const r of callAgents) Object.assign(agentOf(r.agent), { callsAnswered: n(r.answered), callsMade: n(r.made), talkSeconds: Math.round(n(r.talk)) });
  for (const r of msgAgents) agentOf(r.agent).messagesSent = n(r.sent);

  return {
    from: start.toISOString(),
    to: to.toISOString(),
    totals: {
      callsIncoming: n(callTotals?.incoming),
      callsAnswered: n(callTotals?.answered),
      callsMissed: n(callTotals?.missed),
      callsOutgoing: n(callTotals?.outgoing),
      callsOutgoingAnswered: n(callTotals?.outgoingAnswered),
      avgWaitSeconds: Math.round(n(callTotals?.wait)),
      avgTalkSeconds: Math.round(n(callTotals?.talk)),
      messagesReceived: n(msgTotals?.received),
      messagesSent: n(msgTotals?.sent),
      conversations: Object.fromEntries(conv.map((c) => [c.status, c._count._all])),
    },
    days: [...byDay.values()],
    hours,
    agents: [...agents.values()].sort((a, b) => b.callsAnswered + b.messagesSent - (a.callsAnswered + a.messagesSent)),
  };
};
