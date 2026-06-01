// Owner-only profit dashboard at /metrics. Standalone (NOT embedded in any
// merchant's Shopify admin) and gated by a password (OWNER_DASHBOARD_SECRET).
// We deliberately do NOT gate on session.accountOwner because that flag is true
// for every merchant's own owner and would leak global data. When the secret is
// unset, the route 404s (feature disabled). COGS is exact; revenue is estimated
// — see the disclaimer rendered below and app/lib/ownerMetrics.server.ts.

import crypto from "node:crypto";
import { redirect, useActionData, useLoaderData } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

import {
  buildOwnerMetrics,
  type LedgerRow,
  type OwnerMetrics,
  type ShopRow,
} from "../lib/ownerMetrics.server";

export const meta = () => [
  { title: "Owner Metrics — TryOn AI" },
  { name: "robots", content: "noindex,nofollow" },
];

function ownerSecret(): string | null {
  const s = process.env.OWNER_DASHBOARD_SECRET;
  return s && s.length > 0 ? s : null;
}

const COOKIE_NAME = "__tryonai_owner";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// Deterministic auth token derived from the secret, so the raw secret never
// rides in the cookie. Fixed 64-hex chars.
function ownerToken(secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update("owner-dashboard-v1")
    .digest("hex");
}

// Constant-time compare over fixed-length SHA-256 digests (same primitive as
// proxy.server.ts), so length never leaks and timing is uniform.
function timingSafeEqualStr(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a, "utf8").digest();
  const bh = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ah, bh);
}

// Returns EVERY value for `name` in the Cookie header. The browser can send
// multiple cookies with the same name at different paths (e.g. a stale
// /metrics-scoped cookie from an older build alongside the current /-scoped
// one); we must check all of them, not just the first.
function readCookieValues(header: string | null, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) out.push(part.slice(eq + 1));
  }
  return out;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = ownerSecret();
  if (!secret) throw new Response("Not Found", { status: 404 });

  const want = ownerToken(secret);
  const authed = readCookieValues(
    request.headers.get("Cookie"),
    COOKIE_NAME,
  ).some((v) => timingSafeEqualStr(v, want));
  if (authed) {
    const metrics = await buildOwnerMetrics();
    return { authed: true as const, metrics };
  }
  return { authed: false as const, metrics: null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const secret = ownerSecret();
  if (!secret) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  if (!timingSafeEqualStr(password, secret)) {
    return { error: "Incorrect password." };
  }
  const secureFlag = process.env.NODE_ENV === "production" ? " Secure;" : "";
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${ownerToken(secret)}; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
  );
  // Delete any legacy /metrics-scoped cookie from older builds — same name at a
  // more-specific path would otherwise shadow the new one and break login.
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/metrics; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=0`,
  );
  return redirect("/metrics", { headers });
};

// ---------------------------------------------------------------------------
// Rendering (plain HTML + inline styles; non-embedded, so no Polaris s-* tags)
// ---------------------------------------------------------------------------

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const GREEN = "#047857";
const RED = "#b91c1c";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";

const usd2 = (n: number) => `$${n.toFixed(2)}`;
const usd4 = (n: number) => `$${n.toFixed(4)}`;
const pct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);
const money = (n: number) => (n >= 0 ? usd2(n) : `-${usd2(Math.abs(n))}`);

const DT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  hour12: false,
});
const DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  timeZone: "UTC",
});
const fmtDate = (iso: string | null) => (iso ? DATE.format(new Date(iso)) : "—");

export default function Metrics() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  if (!data.authed || !data.metrics) {
    return <LoginForm error={actionData?.error} />;
  }
  return <Dashboard m={data.metrics} />;
}

function LoginForm({ error }: { error?: string }) {
  return (
    <main
      style={{
        fontFamily: FONT,
        maxWidth: 360,
        margin: "12vh auto",
        padding: "0 1rem",
        color: "#1f2937",
      }}
    >
      <h1 style={{ fontSize: 20 }}>TryOn AI — Owner metrics</h1>
      <p style={{ color: MUTED, fontSize: 14 }}>
        Private dashboard. Enter the owner password to continue.
      </p>
      <form method="post" action="/metrics" style={{ marginTop: "1rem" }}>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Password"
          aria-label="Owner password"
          style={{
            width: "100%",
            padding: "0.6rem 0.7rem",
            fontSize: 16,
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            boxSizing: "border-box",
          }}
        />
        <button
          type="submit"
          style={{
            marginTop: "0.75rem",
            width: "100%",
            padding: "0.6rem",
            fontSize: 15,
            background: "#111827",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Enter
        </button>
      </form>
      {error ? (
        <p style={{ color: RED, fontSize: 14, marginTop: "0.75rem" }}>{error}</p>
      ) : null}
    </main>
  );
}

function Dashboard({ m }: { m: OwnerMetrics }) {
  const t = m.totals;
  const paidSummary =
    Object.entries(t.paidActiveByPlan)
      .map(([k, v]) => `${v}× ${k}`)
      .join(", ") || "none";

  return (
    <main
      style={{
        fontFamily: FONT,
        maxWidth: 1120,
        margin: "1.5rem auto",
        padding: "0 1rem",
        color: "#1f2937",
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 2 }}>TryOn AI — Profit dashboard</h1>
      <p style={{ color: MUTED, fontSize: 13, marginTop: 0 }}>
        Generated {m.generatedAtUtc} · {t.shopsTotal} shops
      </p>

      <div
        style={{
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 8,
          padding: "0.6rem 0.8rem",
          fontSize: 12.5,
          color: "#92400e",
          margin: "0.75rem 0 1.25rem",
        }}
      >
        <strong>COGS is exact</strong> (real OpenAI cost per try-on, both passes).{" "}
        <strong>Revenue is estimated</strong> from current plan config: monthly
        run-rate (MRR) + overage above included, counting only{" "}
        <em>active</em> paid subscriptions. It does not prorate partial months and
        does not reflect refunds, declines, chargebacks, or Shopify collection vs.
        acceptance. All times are UTC.
      </div>

      <SectionTitle>Current billing cycle (run-rate)</SectionTitle>
      <CardRow>
        <Card label="Revenue (est.)" value={usd2(t.revenueCycle)} />
        <Card label="COGS (exact)" value={usd2(t.cogsCycle)} />
        <Card
          label="Profit"
          value={money(t.profitCycle)}
          color={t.profitCycle >= 0 ? GREEN : RED}
          big
        />
        <Card label="Margin" value={pct(t.marginCycle)} />
      </CardRow>
      <CardRow>
        <Card label="MRR (active paid)" value={usd2(t.mrr)} />
        <Card label="Overage rev (est.)" value={usd2(t.overageRevCycle)} />
        <Card label="Trial CAC (cycle)" value={money(-t.trialCacCycle)} color={RED} />
        <Card label="Active paid plans" value={paidSummary} small />
        <Card label="Trial shops" value={String(t.trialShops)} />
      </CardRow>

      <SectionTitle>All-time (cost)</SectionTitle>
      <CardRow>
        <Card label="Successful try-ons" value={m.allTime.tryOnsOk.toLocaleString("en-US")} />
        <Card label="Total COGS (exact)" value={usd2(m.allTime.cogs)} />
        <Card label="Trial CAC burn" value={money(-m.allTime.trialCac)} color={RED} />
      </CardRow>

      <SectionTitle>Shops by category</SectionTitle>
      <CategoryTable rows={m.byCategory} />

      <SectionTitle>Per shop — every install, sorted by all-time cost</SectionTitle>
      <ShopTable rows={m.shops} />

      <SectionTitle>Recent try-ons (latest 100)</SectionTitle>
      <Ledger rows={m.ledger} />

      <SectionTitle>Last 30 days (UTC)</SectionTitle>
      <Trend points={m.trend} />
    </main>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 15, margin: "1.5rem 0 0.5rem", color: "#374151" }}>
      {children}
    </h2>
  );
}

function CardRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>{children}</div>
  );
}

function Card({
  label,
  value,
  color,
  big,
  small,
}: {
  label: string;
  value: string;
  color?: string;
  big?: boolean;
  small?: boolean;
}) {
  return (
    <div
      style={{
        flex: "1 1 150px",
        minWidth: 130,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        padding: "0.6rem 0.75rem",
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 11.5, color: MUTED, textTransform: "uppercase", letterSpacing: 0.3 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: small ? 14 : big ? 26 : 19,
          fontWeight: 600,
          color: color ?? "#111827",
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  fontSize: 11.5,
  color: MUTED,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  padding: "0.4rem 0.5rem",
  borderBottom: `2px solid ${BORDER}`,
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  fontSize: 13,
  padding: "0.4rem 0.5rem",
  borderBottom: `1px solid ${BORDER}`,
  whiteSpace: "nowrap",
};
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

function tableWrap(children: React.ReactNode) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 700 }}>
        {children}
      </table>
    </div>
  );
}

function catColor(c: string): string {
  if (c === "Paying") return GREEN;
  if (c === "Trial") return "#b45309";
  return MUTED;
}

function CategoryTable({ rows }: { rows: OwnerMetrics["byCategory"] }) {
  if (rows.length === 0) return <Empty>No shops yet.</Empty>;
  const totalShops = rows.reduce((a, r) => a + r.shops, 0);
  const totalCost = rows.reduce((a, r) => a + r.cogsAllTime, 0);
  const totalMrr = rows.reduce((a, r) => a + r.mrr, 0);
  return tableWrap(
    <>
      <thead>
        <tr>
          <th style={th}>Category</th>
          <th style={{ ...th, textAlign: "right" }}>Shops</th>
          <th style={{ ...th, textAlign: "right" }}>Try-ons (all-time)</th>
          <th style={{ ...th, textAlign: "right" }}>Cost (all-time)</th>
          <th style={{ ...th, textAlign: "right" }}>MRR</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.category}>
            <td style={{ ...td, color: catColor(r.category), fontWeight: 600 }}>
              {r.category}
            </td>
            <td style={tdNum}>{r.shops}</td>
            <td style={tdNum}>{r.tryOnsAllTime.toLocaleString("en-US")}</td>
            <td style={{ ...tdNum, color: RED }}>{usd2(r.cogsAllTime)}</td>
            <td style={{ ...tdNum, color: r.mrr > 0 ? GREEN : MUTED }}>{usd2(r.mrr)}</td>
          </tr>
        ))}
        <tr style={{ borderTop: `2px solid ${BORDER}` }}>
          <td style={{ ...td, fontWeight: 700 }}>Total</td>
          <td style={{ ...tdNum, fontWeight: 700 }}>{totalShops}</td>
          <td style={tdNum} />
          <td style={{ ...tdNum, fontWeight: 700, color: RED }}>{usd2(totalCost)}</td>
          <td style={{ ...tdNum, fontWeight: 700, color: totalMrr > 0 ? GREEN : MUTED }}>
            {usd2(totalMrr)}
          </td>
        </tr>
      </tbody>
    </>,
  );
}

function ShopTable({ rows }: { rows: ShopRow[] }) {
  if (rows.length === 0) return <Empty>No shops yet.</Empty>;
  return tableWrap(
    <>
      <thead>
        <tr>
          <th style={th}>Shop</th>
          <th style={th}>Category</th>
          <th style={th}>Plan</th>
          <th style={th}>Status</th>
          <th style={{ ...th, textAlign: "right" }}>Cost (all-time)</th>
          <th style={{ ...th, textAlign: "right" }}>Try-ons (all)</th>
          <th style={th}>Installed</th>
          <th style={{ ...th, textAlign: "right" }}>Try-ons (cyc)</th>
          <th style={{ ...th, textAlign: "right" }}>Incl.</th>
          <th style={{ ...th, textAlign: "right" }}>Overage</th>
          <th style={{ ...th, textAlign: "right" }}>Revenue (cyc)</th>
          <th style={{ ...th, textAlign: "right" }}>COGS (cyc)</th>
          <th style={{ ...th, textAlign: "right" }}>Profit (cyc)</th>
          <th style={{ ...th, textAlign: "right" }}>Margin</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.domain} style={{ background: i % 2 ? "#fafafa" : "#fff" }}>
            <td style={td}>{r.domain}</td>
            <td style={{ ...td, color: catColor(r.category), fontWeight: 600 }}>
              {r.category}
            </td>
            <td style={td}>{r.planLabel}</td>
            <td style={{ ...td, color: r.isPaidActive ? GREEN : MUTED }}>{r.status}</td>
            <td style={{ ...tdNum, color: RED, fontWeight: 600 }}>{usd2(r.cogsAllTime)}</td>
            <td style={tdNum}>{r.tryOnsAllTime}</td>
            <td style={{ ...td, color: MUTED }}>{fmtDate(r.installedAt)}</td>
            <td style={tdNum}>{r.cycleTryOns}</td>
            <td style={tdNum}>{r.included}</td>
            <td style={tdNum}>{r.overageUnits || ""}</td>
            <td style={tdNum}>{usd2(r.revenue)}</td>
            <td style={tdNum}>{usd2(r.cogsCycle)}</td>
            <td style={{ ...tdNum, color: r.profitCycle >= 0 ? GREEN : RED, fontWeight: 600 }}>
              {money(r.profitCycle)}
            </td>
            <td style={tdNum}>{pct(r.margin)}</td>
          </tr>
        ))}
      </tbody>
    </>,
  );
}

function Ledger({ rows }: { rows: LedgerRow[] }) {
  if (rows.length === 0) return <Empty>No try-ons logged yet.</Empty>;
  return tableWrap(
    <>
      <thead>
        <tr>
          <th style={th}>Time (UTC)</th>
          <th style={th}>Shop</th>
          <th style={th}>Plan</th>
          <th style={th}>Size</th>
          <th style={{ ...th, textAlign: "right" }}>Cost</th>
          <th style={th}>Status</th>
          <th style={th}>Billing event</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const ok = r.status === "ok";
          return (
            <tr key={r.id} style={{ background: ok ? "#fff" : "#fff7f7" }}>
              <td style={td}>{DT.format(new Date(r.createdAt))}</td>
              <td style={td}>{r.shop}</td>
              <td style={td}>{r.plan}</td>
              <td style={td}>{r.size}</td>
              <td style={tdNum}>{usd4(r.costUsd)}</td>
              <td style={{ ...td, color: ok ? GREEN : RED }}>{r.status}</td>
              <td style={{ ...td, color: MUTED }}>{r.billingEventStatus ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </>,
  );
}

function Trend({ points }: { points: OwnerMetrics["trend"] }) {
  if (points.length === 0) return <Empty>No activity in the last 30 days.</Empty>;
  const maxCogs = Math.max(...points.map((p) => p.cogs), 0.0001);
  return tableWrap(
    <>
      <thead>
        <tr>
          <th style={th}>Day</th>
          <th style={{ ...th, textAlign: "right" }}>Try-ons</th>
          <th style={{ ...th, textAlign: "right" }}>OK</th>
          <th style={{ ...th, textAlign: "right" }}>COGS</th>
          <th style={th}>Cost</th>
        </tr>
      </thead>
      <tbody>
        {points.map((p) => (
          <tr key={p.day}>
            <td style={td}>{p.day}</td>
            <td style={tdNum}>{p.tryons}</td>
            <td style={tdNum}>{p.ok}</td>
            <td style={tdNum}>{usd2(p.cogs)}</td>
            <td style={{ ...td, width: "40%" }}>
              <div
                style={{
                  height: 10,
                  borderRadius: 3,
                  background: "#d1d5db",
                  width: `${Math.max(2, (p.cogs / maxCogs) * 100)}%`,
                }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </>,
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: MUTED, fontSize: 13 }}>{children}</p>;
}
