export const meta = () => [
  { title: "Privacy Policy — TryOn AI" },
  { name: "robots", content: "index,follow" },
];

const pageStyle = {
  maxWidth: 720,
  margin: "2rem auto",
  padding: "0 1rem",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  lineHeight: 1.6,
  color: "#1f2937",
} as const;

export default function Privacy() {
  return (
    <main style={pageStyle}>
      <h1>Privacy Policy</h1>
      <p>
        <em>Last updated: 2026-05-26</em>
      </p>

      <h2>Data controller</h2>
      <p>
        <strong>Emergence IT</strong>
        <br />
        van Ravesteyn erf 434, 3315 DT Dordrecht, the Netherlands
        <br />
        KVK: 98992678 · BTW: NL005366013B25
        <br />
        Email:{" "}
        <a href="mailto:emergenceit1@gmail.com">emergenceit1@gmail.com</a>
      </p>
      <p>
        Emergence IT operates the TryOn AI Shopify app (&ldquo;the App&rdquo;).
        For the purposes of the EU General Data Protection Regulation (GDPR),
        Emergence IT is the data controller for the data described in this
        policy, except for order data we process on behalf of merchants — in
        that role the merchant is the controller and Emergence IT is the
        processor (see the Data Processing Agreement in our Terms of Service).
      </p>

      <h2>What we process</h2>
      <ul>
        <li>
          <strong>Selfie image</strong> uploaded by the shopper to the try-on
          widget.
        </li>
        <li>
          <strong>Garment image</strong> taken from the merchant&apos;s product
          catalog.
        </li>
        <li>
          <strong>Shopify merchant identifiers</strong> (shop domain, OAuth
          access token) required to embed the app in the Shopify admin.
        </li>
        <li>
          <strong>Order metadata for attributed orders only</strong>: order ID,
          order number, subtotal, financial status, the test flag, and the
          <code> _tryonai_request_id</code> note attribute we wrote at try-on
          time. We do not read customer name, email, phone, address, or any
          other direct personal identifier.
        </li>
      </ul>

      <h2>How we process it</h2>
      <p>
        Selfie and garment images are read into server memory, forwarded to
        OpenAI&apos;s image-generation API, and the generated try-on image is
        streamed back to the shopper&apos;s browser. <strong>We do not write
        any shopper-supplied image to disk or any database.</strong> The images
        exist only for the duration of the request.
      </p>
      <p>
        When a shopper completes a purchase after using the try-on widget,
        Shopify delivers an <code>orders/paid</code> webhook to us. We read the
        order subtotal and our own request-ID note attribute to identify orders
        attributed to a try-on session and to compute the merchant&apos;s
        commission charge. Refunds trigger a corresponding commission credit
        via the <code>refunds/create</code> webhook. We do not access customer
        name, email, address, or phone number.
      </p>

      <h2>Legal basis for processing (GDPR Art. 6)</h2>
      <ul>
        <li>
          <strong>Contract performance</strong> (Art. 6(1)(b)) — processing
          merchant identifiers and order metadata is necessary to provide the
          App and bill the merchant correctly.
        </li>
        <li>
          <strong>Legitimate interests</strong> (Art. 6(1)(f)) — short-lived
          processing of shopper selfies to produce the try-on result is
          necessary to fulfil the shopper&apos;s explicit request. The shopper
          initiates the upload and the image is not retained.
        </li>
        <li>
          <strong>Legal obligation</strong> (Art. 6(1)(c)) — retention of
          billing records (attributed orders, usage logs) is necessary to meet
          Dutch accounting and tax-record-keeping obligations.
        </li>
      </ul>

      <h2>Sub-processors</h2>
      <ul>
        <li>
          <strong>OpenAI, L.L.C.</strong> (United States) — image generation.
          Selfie + garment images are sent to OpenAI to produce the try-on
          result. See{" "}
          <a href="https://openai.com/policies/privacy-policy" rel="noreferrer">
            OpenAI&apos;s privacy policy
          </a>
          .
        </li>
        <li>
          <strong>Shopify Inc.</strong> (Canada / United States) — app hosting
          platform, OAuth, and webhook delivery.
        </li>
        <li>
          <strong>Vercel Inc.</strong> (United States) — application hosting
          and serverless runtime.
        </li>
        <li>
          <strong>Supabase Inc.</strong> (United States; database hosted in the
          EU region eu-west-1) — managed Postgres database for shop-scoped
          settings, billing state, usage logs, and attributed-order records.
          Data is encrypted at rest (AES-256) and in transit (TLS).
        </li>
      </ul>

      <h2>International transfers</h2>
      <p>
        Some sub-processors are established in the United States. When personal
        data is transferred outside the European Economic Area, we rely on the
        European Commission&apos;s Standard Contractual Clauses (SCCs) and,
        where applicable, the EU–U.S. Data Privacy Framework, as the legal
        basis for the transfer.
      </p>

      <h2>Data retention</h2>
      <p>
        <strong>Shopper images: zero retention.</strong> Not persisted to disk
        or database; not logged.
      </p>
      <p>
        <strong>Merchant identifiers and settings:</strong> retained while the
        app is installed and deleted when Shopify sends the{" "}
        <code>shop/redact</code> webhook (48 hours after uninstall).
      </p>
      <p>
        <strong>Attributed order records</strong> (order ID, subtotal,
        commission amount, request ID) and <strong>usage logs</strong>{" "}
        (request ID, OpenAI request ID, plan, cost, status) are retained for up
        to 24 months for billing audit and reconciliation, then deleted. This
        retention period is necessary to comply with Dutch tax-record-keeping
        obligations (Algemene wet inzake rijksbelastingen).
      </p>

      <h2>Your rights (GDPR / CCPA)</h2>
      <p>
        Under the GDPR you have the right to access, rectify, erase, restrict,
        or port your personal data, and to object to processing. Under the
        California Consumer Privacy Act (CCPA) you have the right to know what
        personal information is collected, to delete it, and to opt out of its
        sale (we do not sell personal data).
      </p>
      <p>
        To exercise any of these rights, contact{" "}
        <a href="mailto:emergenceit1@gmail.com">emergenceit1@gmail.com</a>. We
        will respond within 30 days. We may need to verify your identity or
        route the request through the Shopify merchant whose store you
        interacted with, since most data we process is keyed by Shopify
        identifiers we do not directly link to your name.
      </p>
      <p>
        We honor Shopify&apos;s mandatory{" "}
        <code>customers/data_request</code> and <code>customers/redact</code>{" "}
        webhooks. Because we do not store shopper names, emails, phone numbers,
        or addresses, these requests are acknowledged as already-satisfied.
      </p>

      <h2>Supervisory authority</h2>
      <p>
        If you believe our processing of your personal data infringes the GDPR,
        you have the right to lodge a complaint with a supervisory authority.
        For data subjects in the Netherlands, the supervisory authority is the
        Autoriteit Persoonsgegevens (
        <a href="https://autoriteitpersoonsgegevens.nl" rel="noreferrer">
          autoriteitpersoonsgegevens.nl
        </a>
        ). Data subjects in other EU/EEA member states may contact their local
        authority.
      </p>

      <h2>Changes</h2>
      <p>
        We may update this policy; the &ldquo;Last updated&rdquo; date above
        will change. Material changes will be communicated to merchants by
        email or in-app notice.
      </p>

      <h2>Contact</h2>
      <p>
        Privacy questions:{" "}
        <a href="mailto:emergenceit1@gmail.com">emergenceit1@gmail.com</a>
      </p>
    </main>
  );
}
