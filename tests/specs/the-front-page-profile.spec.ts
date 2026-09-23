// The front page's structured content (`@profile`): the lede, "What I do" and
// notable links, stored as one validated JSON document on `site_settings`.
import { beforeAll, describe, expect, it } from 'bun:test'
import { publishPost } from '../../src/core/posts.ts'
import { readProfile, validateProfile } from '../../src/core/site-profile.ts'
import { getSiteSettings } from '../../src/core/site-settings.ts'
import { aBroadcast } from '../support/factories.ts'
import { createWorld, type World } from '../support/world.ts'

const SITE = 'https://site.example.test'

async function saveSite(w: World, fields: Record<string, string>): Promise<Response> {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return w.fetch('/site', { method: 'POST', body: form })
}

describe('Feature: the front page profile', () => {
  describe('Scenario: the operator fills in the front page', () => {
    let w: World
    let html: string

    beforeAll(async () => {
      w = createWorld({ SITE_URL: SITE, SITE_TITLE: 'Big Machine' })
      await publishPost(w.db, await aBroadcast(w, { subject: 'Anything' }))
      await saveSite(w, {
        profile_lede: 'I make AI pay off.',
        do_title_0: 'Advisory',
        do_icon_0: 'compass',
        do_body_0: 'A monthly retainer.',
        link_kind_0: 'Podcast',
        link_title_0: "This Developer's Life",
        link_url_0: 'https://thisdeveloperslife.com/',
        link_blurb_0: 'Stories.',
      })
      html = await (await w.fetch(`${SITE}/`)).text()
    })

    it('stores one validated document', async () => {
      const profile = readProfile((await getSiteSettings(w.db))?.profile)
      expect(profile.what_i_do[0]?.icon).toBe('compass')
    })

    it('shows the lede', () => {
      expect(html).toContain('I make AI pay off.')
    })

    it('shows What I do', () => {
      expect(html).toContain('Advisory')
    })

    it('shows the link, with a readable address', () => {
      expect(html).toContain('thisdeveloperslife.com ↗')
    })
  })

  describe('Scenario: nothing filled in', () => {
    let html: string

    beforeAll(async () => {
      const w = createWorld({ SITE_URL: SITE })
      await publishPost(w.db, await aBroadcast(w, { subject: 'Anything' }))
      html = await (await w.fetch(`${SITE}/`)).text()
    })

    it('renders no What I do section', () => {
      expect(html).not.toContain('id="do-title"')
    })

    it('renders no Notable links section', () => {
      expect(html).not.toContain('id="links-title"')
    })
  })

  // ───────────────────────────────────────────── sad paths

  describe('Scenario: a link that is not a URL', () => {
    let w: World
    let res: Response

    beforeAll(async () => {
      w = createWorld({ SITE_URL: SITE })
      res = await saveSite(w, { short_bio: 'Hi.', link_title_0: 'Broken', link_url_0: 'not a url' })
    })

    it('is refused, naming the field', () => {
      expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('links.0.url')
    })

    it('saves nothing', async () => {
      expect(await getSiteSettings(w.db)).toBeNull()
    })
  })

  describe('Scenario: social profiles by key', () => {
    let w: World
    let html: string

    beforeAll(async () => {
      w = createWorld({ SITE_URL: SITE })
      await publishPost(w.db, await aBroadcast(w, { subject: 'Anything' }))
      await saveSite(w, {
        short_bio: 'Hi.',
        social_github: 'https://github.com/robconery',
        social_mastodon: 'https://mastodon.social/@robconery',
      })
      html = await (await w.fetch(`${SITE}/`)).text()
    })

    it('stores each under its key', async () => {
      const profile = readProfile((await getSiteSettings(w.db))?.profile)
      expect(profile.social).toEqual({ github: 'https://github.com/robconery', mastodon: 'https://mastodon.social/@robconery' })
    })

    it('shows them on the front page, named', () => {
      expect(html).toContain('>GitHub</a>')
    })

    it('leaves out the ones not set', () => {
      expect(html).not.toContain('>Facebook</a>')
    })
  })

  describe('Scenario: a social profile that is not a URL', () => {
    it('is refused', () => {
      expect(validateProfile({ social: { github: 'robconery' } }).ok).toBe(false)
    })
  })

  describe('Scenario: more than six things in What I do', () => {
    it('is refused', () => {
      const seven = Array.from({ length: 7 }, (_, i) => ({ title: `T${i}` }))
      expect(validateProfile({ what_i_do: seven }).ok).toBe(false)
    })
  })

  describe('Scenario: a stored document that no longer fits the schema', () => {
    it('reads as empty rather than breaking the page', () => {
      expect(readProfile({ what_i_do: 'nonsense' }).what_i_do).toEqual([])
    })
  })
})
