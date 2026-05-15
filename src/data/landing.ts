/**
 * Landing-page content. Update copy here, not inside components — keeps
 * the marketing surface editable as data.
 */

export type HeroMeta = { label: string; value: string }

export type Stat = {
  num: string
  unit: string
  leadStrong: string
  body: string
}

export type Feature = {
  index: string
  title: string
  body: string
}

export type DigestPreviewItem = {
  tag: 'Launch' | 'Market' | 'Voice'
  tone: 'launch' | 'market' | 'voc'
  headline: string
  summary: string
  impact: string
}

export type Persona = {
  index: string
  title: string
  body: string
}

export type ProofItem = {
  text: string
  status: 'live' | 'pending'
}

export const HERO = {
  eyebrow: 'Now onboarding the private beta',
  headlineLead: 'The competitive intel briefing that hits your inbox',
  headlineAccent: 'before standup.',
  sub: 'Product Flash scans every changelog, review site, subreddit, and launch announcement your competitors touch — and delivers a 5-minute morning digest of what actually matters.',
  meta: [
    { label: 'For', value: 'Product leaders in SaaS' },
    { label: 'Cadence', value: 'Daily, before 8am local' },
    { label: 'Status', value: 'Private beta · 20 seats' },
  ] satisfies HeroMeta[],
}

export const PROBLEM = {
  label: 'The problem',
  title: 'Your competitor shipped on Tuesday. You found out on Friday.',
  lede: "Product leaders are drowning in tabs — changelogs, G2, Reddit, LinkedIn, Product Hunt, niche Slack groups. The signal is out there. The time to find it isn't.",
  stats: [
    {
      num: '4.2',
      unit: 'hrs',
      leadStrong: 'per week',
      body: 'the average PM spends manually tracking competitors — and most still feel behind.',
    },
    {
      num: '73',
      unit: '%',
      leadStrong: 'of product leaders',
      body: "say they've been blindsided by a competitor launch in the last quarter.",
    },
    {
      num: '6+',
      unit: 'tools',
      leadStrong: 'required',
      body: 'to piece together a single weekly competitive update — and none of them talk to each other.',
    },
  ] satisfies Stat[],
}

export const SOLUTION = {
  label: 'The solution',
  title: 'One briefing. Every morning. Nothing missed.',
  lede: 'Product Flash watches the surfaces that matter, distills the noise with LLMs trained on product intelligence, and ships a tight digest you can read with your first coffee.',
  features: [
    {
      index: '01',
      title: 'Competitor moves',
      body: 'Launches, pricing changes, positioning shifts, and feature releases — surfaced the day they happen.',
    },
    {
      index: '02',
      title: 'Market signal',
      body: 'Funding rounds, M&A, analyst coverage, and category-defining narratives in your space.',
    },
    {
      index: '03',
      title: 'Voice of customer',
      body: 'Review sentiment and social chatter on you, your rivals, and the problems you all claim to solve.',
    },
    {
      index: '04',
      title: 'Tuned to you',
      body: "Pick your competitors, themes, and signal threshold. Skip what's noise. Get what's load-bearing.",
    },
  ] satisfies Feature[],
}

export const DIGEST_PREVIEW = {
  label: 'What lands in your inbox',
  title: '5 minutes. 3 sections. Zero fluff.',
  lede: "A sample of Tuesday morning's brief for a head of product at a mid-market analytics SaaS.",
  fromName: 'Product Flash',
  fromAddress: 'digest@productflash.io',
  date: 'TUE · 07:42',
  greeting: 'Good morning. Three things mattered overnight.',
  items: [
    {
      tag: 'Launch',
      tone: 'launch',
      headline: 'Mixpanel shipped session replay — bundled into Growth tier at no cost.',
      summary: "Direct hit on FullStory's wedge.",
      impact: 'Likely impact on your Q3 enterprise renewals — 4 of your top 20 accounts also run Mixpanel.',
    },
    {
      tag: 'Market',
      tone: 'market',
      headline: 'Amplitude raised $90M Series F, valuation flat from 2023.',
      summary: 'Flat round at this stage signals consolidation pressure across the category.',
      impact: 'Worth raising in your next board prep.',
    },
    {
      tag: 'Voice',
      tone: 'voc',
      headline: 'Heap saw 11 G2 reviews this week citing slow onboarding.',
      summary: 'Theme matches a gap in their docs refresh last month.',
      impact: 'Opportunity for a comparison page targeting "fast time-to-value."',
    },
  ] satisfies DigestPreviewItem[],
}

export const AUDIENCE = {
  label: "Who it's for",
  title: 'Built for the people who own the roadmap.',
  personas: [
    {
      index: '01',
      title: 'Heads of Product',
      body: "Walk into Monday's exec meeting already knowing what your competitors did last week — and what to do about it.",
    },
    {
      index: '02',
      title: 'Product Managers',
      body: 'Replace 4 hours of tab-scanning with a 5-minute read. Spend the recovered time on customers, not Chrome.',
    },
    {
      index: '03',
      title: 'Product Marketing',
      body: 'Catch positioning shifts and pricing changes the day they happen — not the day your sales team loses a deal.',
    },
  ] satisfies Persona[],
}

export const PROOF = {
  label: 'Under the hood',
  title: 'An agent, not a dashboard.',
  paragraphs: [
    'Product Flash combines structured firehoses (changelogs, review platforms, funding databases) with LLM-driven synthesis to turn raw signal into a briefing a human actually wants to read.',
    'No new tab. No dashboard fatigue. It meets you where you already are: email, Slack, or both.',
  ],
  items: [
    { text: 'Firehose data integration (live)', status: 'live' },
    { text: 'LLM-powered synthesis (live)', status: 'live' },
    { text: 'Email + Slack delivery (live)', status: 'live' },
    { text: 'Per-user competitor tuning (live)', status: 'live' },
    { text: 'G2 & Capterra ingestion (Q3)', status: 'pending' },
    { text: 'Customer call transcript ingestion (Q4)', status: 'pending' },
    { text: 'Weekly trend roll-up (Q4)', status: 'pending' },
  ] satisfies ProofItem[],
}

export const CTA = {
  label: '⚡ Private Beta · 20 Seats',
  title: "Stop reading your competitors from your CEO's Slack.",
  body: "We're onboarding 20 product teams this quarter. Beta is free for the first 90 days, with founder access and direct input on the roadmap.",
  primary: { label: 'Claim your seat', href: '/signup' },
  secondary: { label: 'Book a 15-min demo', href: '/signup' },
  fineprint: '// 7 seats remaining as of this week',
}

export const FOOTER = {
  copy: '© 2026 · Built for product leaders who refuse to be last to know.',
}

export const TOPBAR = {
  brand: 'Product Flash',
  meta: 'Executive Summary · 2026',
}
