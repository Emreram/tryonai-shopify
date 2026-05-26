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
        <em>Last updated: 2026-05-26</em>
      </p>

      <h2>1. Parties</h2>
      <p>These Terms of Service form an agreement between:</p>
      <p>
        <strong>Emergence IT</strong> (&ldquo;we&rdquo;, &ldquo;us&rdquo;,
        &ldquo;Provider&rdquo;), a company registered in the Netherlands,
        established at van Ravesteyn erf 434, 3315 DT Dordrecht, the Netherlands. KVK: 98992678.
        BTW: NL005366013B25. Contact:{" "}
        <a href="mailto:emergenceit1@gmail.com">emergenceit1@gmail.com</a>.
      </p>
      <p>
        and the Shopify merchant (&ldquo;you&rdquo;, &ldquo;Merchant&rdquo;)
        installing the TryOn AI Shopify app (&ldquo;the App&rdquo;).
      </p>

      <h2>2. Acceptance</h2>
      <p>
        By installing or using the App you agree to these terms. If you do not
        agree, do not install or use the App. Installation also constitutes
        acceptance of the Data Processing Agreement in Section 8.
      </p>

      <h2>3. What the App does</h2>
      <p>
        The App embeds a try-on widget in a Shopify storefront. When a shopper
        uploads a selfie, the App combines it with a product image to produce a
        try-on preview using OpenAI&apos;s image-generation API.
      </p>

      <h2>4. Merchant obligations</h2>
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

      <h2>5. Generated content</h2>
      <p>
        Try-on images are generated on demand from inputs you and your shoppers
        supply. We do not claim ownership of generated outputs. You are
        responsible for how generated images are used or displayed on your
        storefront.
      </p>

      <h2>6. Availability</h2>
      <p>
        The App depends on the OpenAI API. We do not guarantee uninterrupted
        availability. Scheduled maintenance and provider outages may affect
        try-on generation.
      </p>

      <h2>7. Fees and billing</h2>
      <p>
        Paid plans consist of (a) a flat monthly subscription fee, (b) a
        per-try-on overage rate billed when usage exceeds the plan&apos;s
        included allowance, up to a hard cap at 150% of included after which
        new try-ons are blocked, and (c) a percentage commission on orders
        attributed to a try-on session, with no commission charged during the
        first 30 days of a paid plan. Specific amounts are shown in the Shopify
        Admin at install time and billed through Shopify&apos;s Billing API.
        You can uninstall at any time from the Shopify Admin to cancel future
        charges.
      </p>

      <h2>8. Data Processing Agreement</h2>
      <p>
        This Section constitutes a data processing agreement under Article 28
        of the EU GDPR. Where we process personal data on your behalf (for
        example, order data received via Shopify webhooks for the purpose of
        commission billing), you are the data controller and we are the data
        processor.
      </p>
      <p>
        <strong>Subject matter and duration:</strong> processing as necessary
        to provide the App, for as long as the App is installed.{" "}
        <strong>Nature and purpose:</strong> identifying attributed orders and
        computing commission charges; serving the try-on widget.{" "}
        <strong>Types of personal data:</strong> order identifiers, order
        subtotals, our own note-attribute marker, OAuth session tokens, shop
        domain. <strong>Categories of data subjects:</strong> your customers
        whose orders are attributed to a try-on session.
      </p>
      <p>We commit to:</p>
      <ul>
        <li>
          process personal data only on documented instructions from you,
          including with regard to transfers outside the EEA;
        </li>
        <li>
          ensure that persons authorised to process the data are bound by
          confidentiality;
        </li>
        <li>
          implement appropriate technical and organisational security measures,
          including encryption at rest (AES-256) and in transit (TLS), access
          control, and audit logging;
        </li>
        <li>
          engage sub-processors only as listed in our Privacy Policy, with
          equivalent data-protection obligations imposed by contract;
        </li>
        <li>
          assist you in fulfilling data-subject rights requests and in meeting
          your obligations under GDPR Articles 32–36;
        </li>
        <li>
          notify you without undue delay (and in any event within 72 hours) of
          becoming aware of a personal-data breach affecting your data;
        </li>
        <li>
          at your choice, delete or return all personal data to you at the end
          of the provision of the services, subject to legal retention
          obligations.
        </li>
      </ul>
      <p>
        You authorise us to engage the sub-processors listed in our{" "}
        <a href="/privacy">Privacy Policy</a> and to update that list with at
        least 14 days&apos; notice (delivered in-app or by email).
      </p>

      <h2>9. Termination</h2>
      <p>
        Either party may terminate this agreement at any time by uninstalling
        the App. Upon uninstall, Shopify will deliver a <code>shop/redact</code>{" "}
        webhook 48 hours later, at which point we delete shop-scoped data we
        hold, except attributed-order records and usage logs which are retained
        for up to 24 months for billing audit and Dutch tax-record-keeping
        obligations (see Privacy Policy).
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by applicable law, our total aggregate
        liability arising out of or relating to the App, however caused and
        regardless of the form of action, is limited to the greater of (a) the
        fees you actually paid to us in the twelve (12) months preceding the
        event giving rise to the claim, or (b) one hundred euros (€100).
      </p>
      <p>
        We are not liable for indirect, incidental, special, consequential, or
        punitive damages, or for any loss of profits, revenue, data, or
        goodwill, even if advised of the possibility of such damages.
      </p>
      <p>
        Nothing in this Section limits liability that cannot be excluded under
        Dutch mandatory law, including for intent or gross negligence.
      </p>

      <h2>11. Indemnification</h2>
      <p>
        You agree to indemnify and hold us harmless from any claims, damages,
        and expenses (including reasonable legal fees) arising from (a) your
        use of the App in violation of these terms or applicable law, (b)
        product images you supply to the App that infringe third-party
        intellectual-property or publicity rights, or (c) your failure to
        provide an adequate storefront privacy notice as required by Section 4.
      </p>

      <h2>12. Force majeure</h2>
      <p>
        Neither party is liable for failure or delay in performance to the
        extent caused by circumstances beyond its reasonable control, including
        but not limited to acts of God, war, terrorism, civil unrest,
        government actions, internet or cloud-provider outages, or pandemics.
      </p>

      <h2>13. Disclaimer of warranties</h2>
      <p>
        The App is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;
        without warranty of any kind, express or implied, including but not
        limited to warranties of merchantability, fitness for a particular
        purpose, and non-infringement, to the maximum extent permitted by law.
      </p>

      <h2>14. Governing law and jurisdiction</h2>
      <p>
        These terms are governed by the laws of the Netherlands, excluding its
        conflict-of-laws rules. The competent court of Amsterdam, the
        Netherlands, has exclusive jurisdiction over any dispute arising from
        or in connection with these terms, except where a different forum is
        required by mandatory consumer-protection law in the merchant&apos;s
        country.
      </p>

      <h2>15. Changes</h2>
      <p>
        We may update these terms; the &ldquo;Last updated&rdquo; date above
        will change. Material changes will be communicated to merchants by
        email or in-app notice at least 14 days before they take effect.
        Continued use after the effective date constitutes acceptance.
      </p>

      <h2>16. Contact</h2>
      <p>
        Questions:{" "}
        <a href="mailto:emergenceit1@gmail.com">emergenceit1@gmail.com</a>
      </p>
    </main>
  );
}
