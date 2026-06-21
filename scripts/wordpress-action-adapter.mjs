#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

// Load .env from the project root (two levels up from scripts/)
const envPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

const CAPABILITIES = [
  "wp_session_check",
  "cf7_inventory",
  "cf7_mail_settings_dry_run",
  "cf7_mail_edit",
  "public_form_submit_test",
  "wp_rest_update_page",
  "wp_rest_update_post",
  "wp_rest_create_post"
];

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function hasArg(name) {
  return process.argv.includes(name);
}

function fail(message, code = 1, details = {}) {
  console.error(JSON.stringify({ status: "error", message, ...details }, null, 2));
  process.exit(code);
}

function readJsonFile(filePath, label) {
  if (!filePath) fail(`Missing ${label}`, 2);
  if (!fs.existsSync(filePath)) fail(`${label} not found: ${filePath}`, 2);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isApproved(payload) {
  const action = payload.action || {};
  return Boolean(action.approval || payload.approval || payload.approved);
}

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function sessionDir() {
  return process.env.WORDPRESS_BROWSER_SESSION_DIR
    || process.env.PLAYWRIGHT_SESSION_DIR
    || "C:\\Workspace\\Shared\\Agents\\BrowserSessions\\grizzly-wordpress";
}

function shouldRunHeadless() {
  if (hasArg("--auth")) return false;
  const value = String(process.env.WORDPRESS_HEADLESS || "true").toLowerCase();
  return !["0", "false", "no"].includes(value);
}

async function importPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const candidates = [
      process.env.PLAYWRIGHT_NODE_MODULE_DIR,
      "C:\\Workspace\\Active\\homelab-noc-dashboard\\homelab-noc-dashboard\\homelab-noc-dashboard\\node_modules"
    ].filter(Boolean);
    for (const nodeModulesDir of candidates) {
      const entry = path.join(nodeModulesDir, "playwright", "index.mjs");
      if (fs.existsSync(entry)) return await import(pathToFileURL(entry).href);
    }
    fail("Playwright is not available. Install it or set PLAYWRIGHT_NODE_MODULE_DIR.", 2);
  }
}

async function openContext() {
  const { chromium } = await importPlaywright();
  fs.mkdirSync(sessionDir(), { recursive: true });
  const context = await chromium.launchPersistentContext(sessionDir(), {
    headless: shouldRunHeadless(),
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(Number(process.env.WORDPRESS_BROWSER_TIMEOUT_MS || 15000));
  return { context, page };
}

async function auth(config) {
  const { context, page } = await openContext();
  await page.goto(config.wp_login_url || config.wp_admin_url, { waitUntil: "domcontentloaded" });
  console.log(JSON.stringify({
    adapter: "wordpress-action-adapter",
    status: "auth_browser_open",
    message: "WordPress login page opened. Complete login in the browser, then rerun adapter-status or the approved action.",
    session_dir: sessionDir(),
    login_url: config.wp_login_url || config.wp_admin_url
  }, null, 2));
  if (!shouldRunHeadless()) {
    await page.waitForTimeout(Number(process.env.WORDPRESS_AUTH_HOLD_MS || 300000));
  }
  await context.close();
}

async function checkSavedSession(config) {
  const { context, page } = await openContext();
  try {
    const session = await checkSession(page, config);
    return {
      adapter: "wordpress-action-adapter",
      site_id: config.site_id,
      site_url: config.site_url,
      status: session.logged_in ? "session_ready" : "blocked_auth",
      session_dir: sessionDir(),
      result: session
    };
  } finally {
    await context.close();
  }
}

async function checkSession(page, config) {
  await page.goto(config.wp_admin_url, { waitUntil: "domcontentloaded" });
  const currentUrl = page.url();
  const loggedIn = !currentUrl.includes("wp-login.php")
    && await page.locator("#wpadminbar, #adminmenu, body.wp-admin").count() > 0;
  return {
    capability: "wp_session_check",
    logged_in: loggedIn,
    current_url: currentUrl
  };
}

async function cf7Inventory(page, config) {
  const adminBase = normalizeBaseUrl(config.wp_admin_url);
  await page.goto(`${adminBase}/admin.php?page=wpcf7`, { waitUntil: "domcontentloaded" });
  const rows = await page.locator("table.wp-list-table tbody tr").evaluateAll((items) => items.map((row) => {
    const titleLink = row.querySelector(".row-title");
    const shortcode = row.querySelector(".shortcode")?.textContent?.trim() || "";
    const editUrl = titleLink?.href || "";
    const postId = new URL(editUrl || "https://example.invalid").searchParams.get("post") || "";
    return {
      title: titleLink?.textContent?.trim() || "",
      post_id: postId ? Number(postId) : null,
      shortcode,
      edit_url: editUrl
    };
  })).catch(() => []);
  return {
    capability: "cf7_inventory",
    forms: rows.filter((row) => row.title || row.post_id)
  };
}

async function readCf7Mail(page, config, form) {
  const adminBase = normalizeBaseUrl(config.wp_admin_url);
  await page.goto(`${adminBase}/admin.php?page=wpcf7&post=${form.post_id}&action=edit`, { waitUntil: "domcontentloaded" });
  await openMailPanel(page);
  return {
    post_id: form.post_id,
    name: form.name,
    from: await inputValue(page, 'input[name="wpcf7-mail[sender]"]'),
    recipient: await inputValue(page, 'input[name="wpcf7-mail[recipient]"]'),
    subject: await inputValue(page, 'input[name="wpcf7-mail[subject]"]'),
    additional_headers: await inputValue(page, 'textarea[name="wpcf7-mail[additional_headers]"]')
  };
}

async function openMailPanel(page) {
  const mailTab = page.locator('a[href="#mail-panel"]');
  if (await mailTab.count() === 1) await mailTab.click();
  await page.locator("#mail-panel").waitFor({ state: "attached", timeout: 10000 });
}

async function inputValue(page, selector) {
  const locator = page.locator(selector);
  if (await locator.count() !== 1) return "";
  return await locator.inputValue();
}

function desiredSender(config) {
  const host = new URL(config.site_url).hostname.replace(/^www\./, "");
  return `[_site_title] <wordpress@${host}>`;
}

function desiredReplyTo(existingHeaders) {
  const lines = String(existingHeaders || "").split(/\r?\n/).filter((line) => line.trim());
  const kept = lines.filter((line) => !/^reply-to\s*:/i.test(line));
  kept.unshift("Reply-To: [email]");
  return kept.join("\n");
}

async function repairCf7Mail(page, config, form, live) {
  const before = await readCf7Mail(page, config, form);
  const after = {
    ...before,
    from: desiredSender(config),
    additional_headers: desiredReplyTo(before.additional_headers)
  };
  if (!live) {
    return {
      capability: "cf7_mail_settings_dry_run",
      post_id: form.post_id,
      name: form.name,
      before,
      after
    };
  }
  await page.locator('input[name="wpcf7-mail[sender]"]').fill(after.from);
  await page.locator('textarea[name="wpcf7-mail[additional_headers]"]').fill(after.additional_headers);
  await page.locator("#wpcf7-save").click();
  await page.locator("#message.updated, .notice-success").waitFor({ state: "visible", timeout: 15000 });
  return {
    capability: "cf7_mail_edit",
    post_id: form.post_id,
    name: form.name,
    before,
    after,
    saved: true
  };
}

async function verifyPublicContact(page, config) {
  await page.goto(config.public_contact_url, { waitUntil: "domcontentloaded" });
  const forms = await page.locator(".wpcf7 form").count();
  return {
    capability: "public_form_submit_test",
    url: config.public_contact_url,
    expected_thank_you_url: config.public_contact_thank_you_url,
    forms_found: forms,
    note: "Non-submitting verification only. Live lead tests require explicit operator input."
  };
}

function wpRestAuth() {
  const user = (process.env.WP_USERNAME || "").trim();
  const pass = (process.env.WP_APP_PASSWORD || "").trim();
  if (!user || !pass) throw new Error("WP_USERNAME and WP_APP_PASSWORD must be set in environment.");
  return "Basic " + Buffer.from(user + ":" + pass).toString("base64");
}

async function wpRest(baseUrl, method, endpoint, body) {
  const url = normalizeBaseUrl(baseUrl) + "/wp-json/wp/v2/" + endpoint;
  const options = {
    method,
    headers: { "Authorization": wpRestAuth(), "Content-Type": "application/json" }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(`WP REST ${method} ${endpoint} → ${res.status}: ${data?.message || JSON.stringify(data)}`);
  return data;
}

async function resolveContentId(baseUrl, action, contentType) {
  if (action.page_id) return Number(action.page_id);
  if (action.slug) {
    const endpoint = contentType === "post" ? "posts" : "pages";
    const results = await wpRest(baseUrl, "GET", `${endpoint}?slug=${encodeURIComponent(action.slug)}&_fields=id,title,slug`);
    if (results.length) return results[0].id;
  }
  return null;
}

// Parse blog post content from executor completion deliverable.
// Expected format: TITLE:/EXCERPT:/TAGS: headers, blank line, then HTML or markdown body.
function parseDraftFromDeliverable(deliverable, fallbackTitle) {
  if (!deliverable || !deliverable.trim()) return null;
  const lines = deliverable.split('\n');
  let title = fallbackTitle || '';
  let excerpt = '';
  let tagNames = [];
  let htmlStart = 0;
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const line = lines[i];
    if (line.startsWith('TITLE:')) { title = line.slice(6).trim(); htmlStart = i + 1; }
    else if (line.startsWith('EXCERPT:')) { excerpt = line.slice(8).trim(); htmlStart = i + 1; }
    else if (line.startsWith('TAGS:')) { tagNames = line.slice(5).split(',').map(t => t.trim().replace(/^#/, '')); htmlStart = i + 1; }
    else if (line.trim() === '' && i > 0) { htmlStart = i + 1; break; }
  }
  const bodyText = lines.slice(htmlStart).join('\n').trim();
  if (!bodyText) return null;
  const content = bodyText.startsWith('<') ? bodyText : mdToHtml(bodyText);
  return { title, excerpt, tags: tagNames, content, status: 'draft' };
}

function mdToHtml(md) {
  const rawLines = md.split('\n');
  const out = [];
  let inUl = false;
  for (const raw of rawLines) {
    const line = raw
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
    if (/^###\s/.test(line)) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      out.push(`<h3>${line.replace(/^###\s+/, '')}</h3>`);
    } else if (/^##\s/.test(line)) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      out.push(`<h2>${line.replace(/^##\s+/, '')}</h2>`);
    } else if (/^-\s/.test(line)) {
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${line.replace(/^-\s+/, '')}</li>`);
    } else if (line.trim() === '') {
      if (inUl) { out.push('</ul>'); inUl = false; }
      out.push('');
    } else {
      if (inUl) { out.push('</ul>'); inUl = false; }
      out.push(line);
    }
  }
  if (inUl) out.push('</ul>');
  return out.join('\n').split(/\n\n+/).map(block => {
    const b = block.trim();
    if (!b || /^<(h[23]|ul|li|p)/.test(b)) return b;
    return `<p>${b.replace(/\n/g, ' ')}</p>`;
  }).filter(Boolean).join('\n');
}

async function restContentAction(config, action, live) {
  // blog post actions always create posts, not pages
  const contentType = action.content_type
    || (action.action_type === "website_blog_post" ? "post" : "page");
  const isPost = contentType === "post";
  // draft can come from: action.draft (generate_blog_post flow), action.page_draft,
  // or the executor crew's completion.deliverable (TITLE/EXCERPT/TAGS + HTML format)
  const draft = action.draft || action.page_draft
    || parseDraftFromDeliverable(action.completion?.deliverable, action.title)
    || {};

  const title = draft.title || action.title;
  const content = draft.content || action.content_html || "";
  const excerpt = draft.excerpt || "";
  const publishStatus = draft.status || action.publish_status || "draft";

  const body = { status: publishStatus };
  if (title) body.title = title;
  if (content) body.content = content;
  if (excerpt) body.excerpt = excerpt;
  if (isPost && draft.categories?.length) body.categories = draft.categories;
  if (isPost && draft.tags?.length) body.tags = draft.tags;
  if (isPost && draft.yoast_title) body.yoast_head_json = { title: draft.yoast_title };

  if (!live) {
    let existing = null;
    let resolvedId = null;
    try {
      resolvedId = await resolveContentId(config.site_url, action, contentType);
      if (resolvedId) {
        const endpoint = isPost ? "posts" : "pages";
        existing = await wpRest(config.site_url, "GET", `${endpoint}/${resolvedId}?_fields=id,title,slug,link,status`);
      }
    } catch (_) { /* dry run — ignore lookup errors */ }
    return {
      capability: isPost ? "wp_rest_create_post" : "wp_rest_update_page",
      status: "dry_run_ready",
      content_type: contentType,
      resolved_id: resolvedId,
      existing: existing ? { id: existing.id, title: existing.title?.rendered, slug: existing.slug, link: existing.link } : null,
      would_set: { ...body, content: content ? `[${content.length} chars]` : "" },
      message: resolvedId
        ? `Would update ${contentType} ID ${resolvedId} (status → ${publishStatus})`
        : isPost ? "Would create new blog post" : "WARNING: no page_id or slug matched — live run would fail"
    };
  }

  // Live execution
  if (isPost && !action.page_id && !action.slug) {
    const result = await wpRest(config.site_url, "POST", "posts", body);
    return {
      capability: "wp_rest_create_post",
      status: "live_complete",
      content_type: "post",
      post_id: result.id,
      title: result.title?.rendered,
      slug: result.slug,
      link: result.link,
      post_status: result.status,
      message: `Blog post created — ID ${result.id}, status: ${result.status}`
    };
  }

  const resolvedId = await resolveContentId(config.site_url, action, contentType);
  if (!resolvedId) throw new Error(`Cannot update ${contentType}: no page_id or matching slug found.`);
  const endpoint = isPost ? `posts/${resolvedId}` : `pages/${resolvedId}`;
  const result = await wpRest(config.site_url, "POST", endpoint, body);
  return {
    capability: isPost ? "wp_rest_update_post" : "wp_rest_update_page",
    status: "live_complete",
    content_type: contentType,
    post_id: result.id,
    title: result.title?.rendered,
    slug: result.slug,
    link: result.link,
    post_status: result.status,
    message: `${isPost ? "Post" : "Page"} updated — ID ${result.id}, status: ${result.status}`
  };
}

function formTargets(config, action) {
  const requested = String(action.source_task_id || action.id || "").toUpperCase();
  if (requested === "T002" || /contact form/i.test(action.title || "")) {
    return config.contact_forms || [];
  }
  return [];
}

async function runWordPressAction(config, payload) {
  const action = payload.action || {};
  const live = Boolean(payload.live);
  const response = {
    adapter: "wordpress-action-adapter",
    site_id: config.site_id,
    site_url: config.site_url,
    live,
    action_id: action.id || null,
    action_type: action.action_type || null,
    platform: action.platform || null,
    capabilities: CAPABILITIES,
    status: live ? "live_ready" : "dry_run_ready",
    results: []
  };

  if (live && action.approval_required && !isApproved(payload)) {
    return {
      ...response,
      status: "blocked_approval",
      message: "Live WordPress execution requires an approved action payload."
    };
  }

  if (!live) {
    response.message = "WordPress action payload validated. No live site changes were made.";
    response.results.push({
      capability: "approval_gate",
      approval_required: Boolean(action.approval_required),
      approved: isApproved(payload)
    });
    for (const form of formTargets(config, action)) {
      response.results.push({
        capability: "cf7_mail_settings_dry_run",
        post_id: form.post_id,
        name: form.name,
        after: {
          from: desiredSender(config),
          additional_headers: "Reply-To: [email]"
        }
      });
    }
    if (action.action_type === "website_content_publish" || action.action_type === "website_blog_post") {
      response.results.push(await restContentAction(config, action, false));
    }
    return response;
  }

  const { context, page } = await openContext();
  try {
    const session = await checkSession(page, config);
    response.results.push(session);
    if (!session.logged_in) {
      return {
        ...response,
        status: "blocked_auth",
        message: `WordPress session is not authenticated. Run: node ${path.basename(process.argv[1])} --config <config> --auth`
      };
    }

    response.results.push(await cf7Inventory(page, config));
    const targets = formTargets(config, action);
    if (targets.length) {
      for (const form of targets) {
        response.results.push(await repairCf7Mail(page, config, form, true));
      }
      response.results.push(await verifyPublicContact(page, config));
    } else if (action.action_type === "website_content_publish" || action.action_type === "website_blog_post") {
      response.results.push(await restContentAction(config, action, true));
    }
    response.status = "live_complete";
    response.message = "WordPress browser action completed.";
    return response;
  } finally {
    await context.close();
  }
}

const configPath = readArg("--config");
const payloadText = readArg("--payload");
const config = readJsonFile(configPath, "--config");

if (hasArg("--auth")) {
  await auth(config);
  process.exit(0);
}

if (hasArg("--check-session")) {
  const result = await checkSavedSession(config);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "session_ready") process.exit(5);
  process.exit(0);
}

if (!payloadText) fail("Missing --payload", 2);

const payload = JSON.parse(payloadText);
const result = await runWordPressAction(config, payload);
console.log(JSON.stringify(result, null, 2));

if (result.status === "blocked_approval") process.exit(4);
if (result.status === "blocked_auth") process.exit(5);
if (result.status?.startsWith("blocked_")) process.exit(3);
