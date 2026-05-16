import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components'
import { colors, digestTags, fonts, fontWeights, type DigestTag } from '~/design/tokens'

// React Email template for the daily digest. Intentionally distinct from the
// in-app view at `/app/digests/:id` — emails have to survive Gmail/Outlook
// quirks (no Tailwind, no flex/grid in older clients, inline styles only,
// images blocked by default). Both surfaces consume `src/design/tokens.ts`
// so the brand stays unified, but layout code is not shared.

export interface DigestEmailItem {
  id: string
  category: DigestTag
  headline: string
  snippet: string
  impactNote: string | null
  sourceUrl: string | null
  // Friendly label like "May 14" when the source supplied a publication
  // time; null otherwise. Server-rendered upstream so the template stays
  // pure-presentation. No "today" / "recently" fallbacks (#41).
  occurredAtLabel: string | null
  feedbackUrls: { up: string; down: string }
}

export interface DigestEmailProps {
  // Greeting target — first name when known, else email local-part. Mirrors
  // the synthesizer's fallback (`src/jobs/synthesize.ts`).
  recipientName: string
  // Header eyebrow — "Catch-up brief" vs "Today's brief". Derived from the
  // digest's period span upstream so this stays presentation-only.
  headerLabel: string
  // Range chip on the right of the header band. "May 9 → May 16" or
  // "May 16". Null when legacy / unknown — header band still renders but
  // without the chip.
  rangeLabel: string | null
  // Lede above the items. Same copy contract as the in-app view's greeting.
  greeting: string
  items: DigestEmailItem[]
  // 1×1 pixel URL hit by email clients on render. Updates `digests.opened_at`.
  trackingPixelUrl: string
  // Fully-qualified URL the recipient can click to view this digest in-app.
  appDigestUrl: string
}

const FONT_STACK_SANS = fonts.sans
const FONT_STACK_MONO = fonts.mono

const TAG_LABEL: Record<DigestTag, string> = {
  launch: 'Launch',
  pricing: 'Pricing',
  feature: 'Feature',
  positioning: 'Positioning',
  noise: 'Noise',
}

export function DigestEmail({
  recipientName,
  headerLabel,
  rangeLabel,
  greeting,
  items,
  trackingPixelUrl,
  appDigestUrl,
}: DigestEmailProps) {
  const preview = previewText(items, greeting)

  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Section style={brandHeaderStyle}>
            <table
              cellPadding={0}
              cellSpacing={0}
              role="presentation"
              style={{ borderCollapse: 'collapse' }}
            >
              <tbody>
                <tr>
                  <td style={{ verticalAlign: 'middle', paddingRight: '10px' }}>
                    <BrandGlyph />
                  </td>
                  <td style={brandWordmarkStyle}>Product Flash</td>
                </tr>
              </tbody>
            </table>
          </Section>

          <Section style={cardStyle}>
            <Section style={headerBandStyle}>
              <table
                width="100%"
                cellPadding={0}
                cellSpacing={0}
                role="presentation"
                style={{ borderCollapse: 'collapse' }}
              >
                <tbody>
                  <tr>
                    <td style={headerBrandCellStyle}>
                      <span style={headerBrandStrongStyle}>Product Flash</span>
                      <span style={headerBrandSeparatorStyle}>·</span>
                      <span style={headerLabelStyle}>{headerLabel}</span>
                    </td>
                    <td style={headerRangeCellStyle}>
                      {rangeLabel ? rangeLabel.toUpperCase() : ''}
                    </td>
                  </tr>
                </tbody>
              </table>
            </Section>

            <Section style={bodyPadStyle}>
              <Text style={greetingStyle}>
                {recipientName ? `${recipientName} — ` : null}
                {greeting}
              </Text>

              {items.length === 0 ? (
                <EmptyBlock />
              ) : (
                items.map((item, idx) => (
                  <DigestRow
                    key={item.id}
                    item={item}
                    isLast={idx === items.length - 1}
                  />
                ))
              )}

              {items.length > 0 ? (
                <Section style={appLinkSectionStyle}>
                  <Link href={appDigestUrl} style={appLinkStyle}>
                    Open this brief in the app →
                  </Link>
                </Section>
              ) : null}
            </Section>
          </Section>

          <Section style={footerStyle}>
            <Text style={footerTextStyle}>
              You're getting this because you signed up at productflash.ai. We
              ship one brief a day and a catch-up on signup — nothing else.
            </Text>
            <Text style={footerTextStyle}>
              Reply to this email if anything in the brief was off — we read
              every reply during the beta.
            </Text>
          </Section>

          <Img
            src={trackingPixelUrl}
            width="1"
            height="1"
            alt=""
            style={{ display: 'none', opacity: 0 }}
          />
        </Container>
      </Body>
    </Html>
  )
}

// Brand mark rendered as a CID-referenced PNG (`src/emails/assets/brand-mark.png`).
// Gmail strips inline `<svg>` so the web BrandMark's CSS clip-path can't be
// reused here. The PNG is attached to every outgoing digest send with
// `content_id: 'brand-mark'`; clients fetch it from the email's MIME tree
// without needing a public URL — works identically in dev and prod.
function BrandGlyph() {
  return (
    <Img
      src="cid:brand-mark"
      alt="Product Flash"
      width="22"
      height="22"
      style={{ display: 'block' }}
    />
  )
}

function DigestRow({ item, isLast }: { item: DigestEmailItem; isLast: boolean }) {
  const tone = digestTags[item.category]
  return (
    <Section style={{ paddingBottom: '24px' }}>
      <table
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        role="presentation"
        style={{ borderCollapse: 'collapse' }}
      >
        <tbody>
          <tr>
            <td style={{ verticalAlign: 'top' }}>
              <span
                style={{
                  display: 'inline-block',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  fontSize: '10px',
                  fontWeight: fontWeights.semibold,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  backgroundColor: tone.bg,
                  color: tone.fg,
                }}
              >
                {TAG_LABEL[item.category]}
              </span>
            </td>
          </tr>
          {item.occurredAtLabel ? (
            <tr>
              <td style={{ paddingTop: '10px' }}>
                <span style={occurredAtStyle}>{item.occurredAtLabel}</span>
              </td>
            </tr>
          ) : null}
          <tr>
            <td style={{ paddingTop: item.occurredAtLabel ? '6px' : '10px' }}>
              <span style={headlineStyle}>
                {item.sourceUrl ? (
                  <Link href={item.sourceUrl} style={headlineLinkStyle}>
                    {item.headline}
                  </Link>
                ) : (
                  item.headline
                )}
              </span>
            </td>
          </tr>
          <tr>
            <td style={{ paddingTop: '6px' }}>
              <span style={snippetStyle}>
                {item.snippet}
                {item.impactNote ? (
                  <>
                    {' '}
                    <em style={impactStyle}>{item.impactNote}</em>
                  </>
                ) : null}
              </span>
            </td>
          </tr>
          <tr>
            <td style={{ paddingTop: '14px' }}>
              <Link href={item.feedbackUrls.up} style={feedbackUpStyle}>
                👍 Useful
              </Link>
              <Link href={item.feedbackUrls.down} style={feedbackDownStyle}>
                👎 Skip
              </Link>
            </td>
          </tr>
        </tbody>
      </table>
      {isLast ? null : <Hr style={dividerStyle} />}
    </Section>
  )
}

function EmptyBlock() {
  return (
    <Section style={{ padding: '24px 0', textAlign: 'center' }}>
      <Text style={emptyEyebrowStyle}>Nothing notable</Text>
      <Text style={emptyBodyStyle}>
        Your competitors went quiet. We'd rather tell you nothing happened than
        invent something. Back tomorrow.
      </Text>
    </Section>
  )
}

function previewText(items: DigestEmailItem[], greeting: string): string {
  if (items.length === 0) {
    return 'Quiet on the wires — nothing to flag today.'
  }
  // Top item leads the inbox preview; falls back to greeting if the headline
  // is unexpectedly empty.
  const top = items[0]?.headline?.trim()
  if (top && top.length > 0) return top
  return greeting
}

// --- styles ---

const bodyStyle = {
  margin: 0,
  padding: 0,
  backgroundColor: colors.ink,
  fontFamily: FONT_STACK_SANS,
  color: colors.text,
}

const containerStyle = {
  width: '100%',
  maxWidth: '640px',
  margin: '0 auto',
  padding: '32px 16px',
}

const brandHeaderStyle = {
  padding: '0 12px 24px 12px',
}

const brandWordmarkStyle = {
  verticalAlign: 'middle' as const,
  fontFamily: FONT_STACK_SANS,
  fontSize: '17px',
  fontWeight: fontWeights.extrabold,
  letterSpacing: '-0.01em',
  color: '#ffffff',
}

const cardStyle = {
  borderRadius: '20px',
  border: '1px solid #2a2a38',
  backgroundColor: colors.inkSoft,
  overflow: 'hidden',
}

const headerBandStyle = {
  backgroundColor: '#1a1a23',
  borderBottom: '1px solid #2a2a38',
  padding: '20px 28px',
}

const headerBrandCellStyle = {
  fontSize: '13px',
  color: '#888888',
  fontFamily: FONT_STACK_SANS,
}

const headerBrandStrongStyle = {
  color: '#ffffff',
  fontWeight: fontWeights.semibold,
}

const headerBrandSeparatorStyle = {
  margin: '0 6px',
  color: '#888888',
}

const headerLabelStyle = {
  color: '#888888',
}

const headerRangeCellStyle = {
  fontFamily: FONT_STACK_MONO,
  fontSize: '12px',
  color: '#666666',
  textAlign: 'right' as const,
  whiteSpace: 'nowrap' as const,
}

const bodyPadStyle = {
  padding: '32px 28px',
}

const greetingStyle = {
  margin: '0 0 24px 0',
  fontSize: '14px',
  lineHeight: '1.55',
  color: '#888888',
  fontFamily: FONT_STACK_SANS,
}

const occurredAtStyle = {
  fontFamily: FONT_STACK_MONO,
  fontSize: '11px',
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  color: '#7a7a88',
}

const headlineStyle = {
  fontFamily: FONT_STACK_SANS,
  fontSize: '16px',
  fontWeight: fontWeights.semibold,
  lineHeight: '1.4',
  color: '#ffffff',
}

const headlineLinkStyle = {
  color: '#ffffff',
  textDecoration: 'none',
}

const snippetStyle = {
  fontFamily: FONT_STACK_SANS,
  fontSize: '14px',
  lineHeight: '1.55',
  color: '#aaaaaa',
}

const impactStyle = {
  fontStyle: 'normal' as const,
  color: colors.accent,
}

const feedbackUpStyle = {
  display: 'inline-block',
  marginRight: '8px',
  padding: '6px 12px',
  borderRadius: '999px',
  border: '1px solid #2a2a38',
  fontFamily: FONT_STACK_SANS,
  fontSize: '12px',
  color: '#a8a8b8',
  textDecoration: 'none',
}

const feedbackDownStyle = feedbackUpStyle

const dividerStyle = {
  borderColor: '#2a2a38',
  margin: '4px 0 24px 0',
}

const appLinkSectionStyle = {
  marginTop: '8px',
  paddingTop: '20px',
  borderTop: '1px solid #2a2a38',
  textAlign: 'center' as const,
}

const appLinkStyle = {
  fontFamily: FONT_STACK_SANS,
  fontSize: '13px',
  color: colors.accent,
  textDecoration: 'none',
}

const footerStyle = {
  padding: '24px 12px 0 12px',
}

const footerTextStyle = {
  margin: '0 0 8px 0',
  fontFamily: FONT_STACK_SANS,
  fontSize: '12px',
  lineHeight: '1.55',
  color: '#5a5a6a',
  textAlign: 'center' as const,
}

const emptyEyebrowStyle = {
  margin: '0 0 8px 0',
  fontFamily: FONT_STACK_SANS,
  fontSize: '11px',
  fontWeight: fontWeights.semibold,
  letterSpacing: '0.15em',
  textTransform: 'uppercase' as const,
  color: '#666666',
}

const emptyBodyStyle = {
  margin: 0,
  fontFamily: FONT_STACK_SANS,
  fontSize: '14px',
  lineHeight: '1.55',
  color: '#a8a8b8',
}

export default DigestEmail
