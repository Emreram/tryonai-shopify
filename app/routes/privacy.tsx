export const meta = () => [
  { title: "Privacy Policy - TryOn AI" },
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
        <em>Last updated: 2026-05-28</em>
      </p>

      <h2>Data controller</h2>
      <p>
        <strong>Emergence IT</strong>
        <br />
        van Ravesteyn erf 434, 3315 DT Dordrecht, the Netherlands
        <br />
        KVK: 98992678 - BTW: NL005366013B25
        <br />
        Email:{" "}
        <a href="mailto:emergenceit1@gmail.com">emergenceit1@gmail.com</a>
      </p>
      <p>
        Emergence IT operates the TryOn AI Shopify app (&ldquo;the App&rdquo;).
        For the purposes of the EU General Data Protection Regulation (GDPR),
        Emergence IT is the data controller for the data described in this
        policy.
      </p>

      <h2>What we process</h2>
      <ul>
        <li>
          <strong>Selfie image</strong> uploaded by the shopper to the try-on
          widget.
        </li>
        <li>
          <strong>Garment image</strong> taken from the merchant&apos;s product
          page or uploaded by the shopper.
        </li>
        <li>
          <strong>Shopify merchant identifiers</strong> such as shop domain,
          Shopify shop ID, OAuth access token, and billing plan state.
        </li>
        <li>
          <strong>Usage logs</strong> such as request ID, plan, status, image
          size, OpenAI request ID, model cost, and timing metadata.
        </li>
      </ul>

      <h2>How we process it</h2>
      <p>
        Selfie and garment images are read into server memory, forwarded to
        OpenAI&apos;s image-generation API, and the generated try-on image is
        streamed back to the shopper&apos;s browser. <strong>We do not write
        any shopper-supplied image or generated try-on image to disk or any
        database.</strong>
      </p>
      <p>
        Try-on usage is logged so merchants can monitor app usage, enforce plan
        limits, export usage history, and support billing through Shopify App
        Pricing. The App does not request order access and does not read
        customer names, emails, phone numbers, addresses, or order contents.
      </p>

      <h2>Legal basis for processing (GDPR Art. 6)</h2>
      <ul>
        <li>
          <strong>Contract performance</strong> (Art. 6(1)(b)) - processing
          merchant identifiers and usage logs is necessary to provide the App.
        </li>
        <li>
          <strong>Legitimate interests</strong> (Art. 6(1)(f)) - short-lived
          processing of shopper images is necessary to fulfil the shopper&apos;s
          explicit try-on request.
        </li>
        <li>
          <strong>Legal obligation</strong> (Art. 6(1)(c)) - retention of
          billing-related usage records may be necessary for Dutch accounting
          and tax-record-keeping obligations.
        </li>
      </ul>

      <h2>Sub-processors</h2>
      <ul>
        <li>
          <strong>OpenAI, L.L.C.</strong> (United States) - image generation.
          See{" "}
          <a href="https://openai.com/policies/privacy-policy" rel="noreferrer">
            OpenAI&apos;s privacy policy
          </a>
          .
        </li>
        <li>
          <strong>Shopify Inc.</strong> (Canada / United States) - app
          platform, OAuth, billing, and webhook delivery.
        </li>
        <li>
          <strong>Vercel Inc.</strong> (United States) - application hosting
          and serverless runtime.
        </li>
        <li>
          <strong>Supabase Inc.</strong> (United States; database hosted in the
          EU region eu-west-1) - managed Postgres database for shop-scoped
          settings, billing state, and usage logs.
        </li>
      </ul>

      <h2>International transfers</h2>
      <p>
        Some sub-processors are established in the United States. When personal
        data is transferred outside the European Economic Area, we rely on the
        European Commission&apos;s Standard Contractual Clauses and, where
        applicable, the EU-U.S. Data Privacy Framework.
      </p>

      <h2>Data retention</h2>
      <p>
        <strong>Shopper images: zero retention.</strong> They are not persisted
        to disk or database and are not logged.
      </p>
      <p>
        <strong>Merchant identifiers and settings:</strong> retained while the
        app is installed and deleted when Shopify sends the <code>shop/redact</code>{" "}
        webhook after uninstall.
      </p>
      <p>
        <strong>Usage logs:</strong> retained for up to 24 months for billing
        audit, abuse prevention, support, and tax-record-keeping.
      </p>

      <h2>Your rights (GDPR / CCPA)</h2>
      <p>
        To exercise access, rectification, erasure, restriction, portability,
        or objection rights, contact{" "}
        <a href="mailto:emergenceit1@gmail.com">emergenceit1@gmail.com</a>. We
        will respond within 30 days.
      </p>
      <p>
        We honor Shopify&apos;s mandatory <code>customers/data_request</code>{" "}
        and <code>customers/redact</code> webhooks. Because we do not store
        shopper names, emails, phone numbers, or addresses, these requests are
        acknowledged as already satisfied.
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
        ).
      </p>

      <h2>Contact</h2>
      <p>
        Privacy questions:{" "}
        <a href="mailto:emergenceit1@gmail.com">emergenceit1@gmail.com</a>
      </p>
    </main>
  );
}
