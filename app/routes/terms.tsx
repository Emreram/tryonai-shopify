export const meta = () => [
  { title: "Terms of Service — TryOn AI" },
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

export default function Terms() {
  return (
    <main style={pageStyle}>
      <h1>Terms of Service</h1>
      <p>
        <em>Last updated: 2026-05-20</em>
      </p>

      <h2>1. Acceptance</h2>
      <p>
        By installing or using the TryOn AI Shopify app (&ldquo;the App&rdquo;) you agree
        to these terms. If you do not agree, do not install or use the App.
      </p>

      <h2>2. What the App does</h2>
      <p>
        The App embeds a try-on widget in a Shopify storefront. When a shopper
        uploads a selfie, the App combines it with a product image to produce
        a try-on preview using OpenAI&apos;s image-generation API.
      </p>

      <h2>3. Merchant obligations</h2>
      <ul>
        <li>
          You confirm you have the right to display the product images you make
          available to the App.
        </li>
        <li>
          You will publish, on the storefront that hosts the widget, a privacy
          notice that discloses the use of shopper selfies and names OpenAI as
          a sub-processor — or you will link to ours.
        </li>
        <li>
          You will comply with Shopify&apos;s Acceptable Use Policy and all
          applicable laws in your jurisdiction.
        </li>
      </ul>

      <h2>4. Generated content</h2>
      <p>
        Try-on images are generated on demand from inputs you and your shoppers
        supply. We do not claim ownership of generated outputs. You are
        responsible for how generated images are used or displayed on your
        storefront.
      </p>

      <h2>5. Availability</h2>
      <p>
        The App depends on the OpenAI API. We do not guarantee uninterrupted
        availability. Scheduled maintenance and provider outages may affect
        try-on generation.
      </p>

      <h2>6. Fees and billing</h2>
      <p>
        Pricing, if any, is shown in the Shopify Admin at install time and
        billed through Shopify&apos;s Billing API. You can uninstall at any time
        from the Shopify Admin to cancel future charges.
      </p>

      <h2>7. Termination</h2>
      <p>
        Either party may terminate this agreement at any time by uninstalling
        the App. Upon uninstall, Shopify will deliver a <code>shop/redact</code>{" "}
        webhook 48 hours later, at which point we delete shop-scoped data we
        hold.
      </p>

      <h2>8. Disclaimer</h2>
      <p>
        The App is provided &ldquo;as is&rdquo; without warranty of any kind. We are not
        liable for indirect or consequential damages arising from use of the
        App, to the maximum extent permitted by law.
      </p>

      <h2>9. Changes</h2>
      <p>
        We may update these terms; the &ldquo;Last updated&rdquo; date above will change.
        Continued use after a change constitutes acceptance.
      </p>

      <h2>10. Contact</h2>
      <p>
        Questions: <a href="mailto:support@tryonai.app">support@tryonai.app</a>
      </p>
    </main>
  );
}
