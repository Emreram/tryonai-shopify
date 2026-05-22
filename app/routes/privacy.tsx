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
        <em>Last updated: 2026-05-20</em>
      </p>

      <h2>Who we are</h2>
      <p>
        TryOn AI (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is a Shopify app that lets shoppers preview a
        garment on themselves by generating a composite image from a selfie and
        a product photo. This policy explains what data we process and how.
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
      </ul>

      <h2>How we process it</h2>
      <p>
        Selfie and garment images are read into server memory, forwarded to
        OpenAI&apos;s image-generation API, and the generated try-on image is
        streamed back to the shopper&apos;s browser. <strong>We do not write any
        shopper-supplied image to disk or any database.</strong> The images
        exist only for the duration of the request.
      </p>

      <h2>Sub-processors</h2>
      <ul>
        <li>
          <strong>OpenAI, L.L.C.</strong> — image generation
          (<code>gpt-image-2</code>). Selfie + garment images are sent to OpenAI
          to produce the try-on result. See{" "}
          <a href="https://openai.com/policies/privacy-policy" rel="noreferrer">
            OpenAI&apos;s privacy policy
          </a>
          .
        </li>
        <li>
          <strong>Shopify Inc.</strong> — app hosting platform, OAuth, and
          webhook delivery.
        </li>
      </ul>

      <h2>Data retention</h2>
      <p>
        <strong>Shopper images: zero retention.</strong> Not persisted to disk
        or database; not logged.
      </p>
      <p>
        <strong>Merchant data:</strong> OAuth sessions and shop-scoped settings
        are retained while the app is installed and deleted when Shopify sends
        the <code>shop/redact</code> webhook (48 hours after uninstall).
      </p>

      <h2>Your rights (GDPR / CCPA)</h2>
      <p>
        Shoppers can request access or deletion of their personal data through
        the Shopify store they interacted with. We honor Shopify&apos;s mandatory
        <code> customers/data_request</code> and <code>customers/redact</code>{" "}
        webhooks. Because we do not store shopper data, these requests are
        acknowledged as already-satisfied.
      </p>

      <h2>Contact</h2>
      <p>
        Privacy questions: <a href="mailto:emergenceit1@gmail.com">emergenceit1@gmail.com</a>
      </p>
    </main>
  );
}
