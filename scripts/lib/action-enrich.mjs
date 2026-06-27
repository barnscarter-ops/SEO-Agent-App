// scripts/lib/action-enrich.mjs
// Pure helpers for enriching /seo/actions payloads. No I/O — unit-testable.

const BUCKET = {
  pending_approval: 'pending', approved: 'pending', awaiting_prompt: 'pending', scheduled: 'pending',
  executing: 'in_process', posting: 'in_process', research_running: 'in_process', execute_running: 'in_process',
  done: 'completed', posted: 'completed',
  error: 'failed', needs_verification: 'failed',
};

export function bucketStatus(dbStatus) {
  return BUCKET[String(dbStatus || '').toLowerCase()] || 'pending';
}

// Per-action-type stuck thresholds (ms). See spec §5.
export const STUCK_THRESHOLDS = {
  website_task:          15 * 60 * 1000,
  weekly_post_gbp:       20 * 60 * 1000,
  weekly_post_facebook:  60 * 60 * 1000,
  seo_run:              240 * 60 * 1000, // 4h — full weekly run can legitimately run long
};

// `since` is the ISO time the row entered an in_process state (we use updated_at,
// which the DB trigger refreshes on the status flip). null/absent => not stuck.
export function isStuck(thresholdKey, since) {
  const limit = STUCK_THRESHOLDS[thresholdKey];
  if (!limit || !since) return false;
  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) > limit;
}

const DESCRIPTIONS = {
  seo_run: () => 'Full weekly SEO run: research + content generation for the next 7 days.',
  gbp_profile_update: () => "Update Grizzly's Google Business Profile (hours, services, info) — not a re-claim.",
  publish_gbp_post: (a) => `Publish a scheduled Google Business post for ${a.post_date || 'this week'}.`,
  publish_facebook_post: (a) => `Publish a Facebook post for ${a.post_date || 'this week'} (${a.media_status || 'media TBD'}).`,
  weekly_post_gbp: (a) => `Publish a scheduled Google Business post for ${a.post_date || 'this week'}.`,
  weekly_post_facebook: (a) => `Publish a Facebook post for ${a.post_date || 'this week'} (${a.media_status || 'media TBD'}).`,
  website_technical_change: () => 'Technical SEO change on grizzlyheating.com.',
  website_content_publish: () => 'Publish website content / blog post.',
  website_blog_post: () => 'Publish website content / blog post.',
  website_task: () => 'Website SEO task on grizzlyheating.com.',
  review_management: () => 'Request or respond to customer reviews.',
};

function descKey(a) {
  if (a.type === 'weekly_post') return a.platform === 'facebook' ? 'weekly_post_facebook' : 'weekly_post_gbp';
  return a.type;
}

export function describeAction(a, dbDescription) {
  const fromDb = (dbDescription ?? a.description ?? '').toString().trim();
  if (fromDb) return fromDb;
  const fn = DESCRIPTIONS[descKey(a)];
  return fn ? fn(a) : 'SEO action.';
}

const AGENTS = {
  seo_run: 'SEO Crew',
  gbp_profile_update: 'GBP Profile Agent',
  weekly_post_gbp: 'Grizzly GBP Poster Agent',
  weekly_post_facebook: 'Grizzly Facebook Poster Agent',
  website_task: 'Website Agent',
  website_content_publish: 'Website Content Agent',
  review_management: 'Review Agent',
};

export function agentFor(a) {
  return AGENTS[descKey(a)] || 'SEO Crew';
}

// Map (scheduled type, media actually attached) -> truthful media_status.
export function mediaStatusFor(scheduledType, attached) {
  if (attached === 'video') return 'video';
  if (attached === 'photo') return scheduledType === 'video' ? 'downgraded' : 'photo';
  return 'none';
}
